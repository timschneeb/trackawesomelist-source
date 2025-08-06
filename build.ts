import { CSS, groupBy, jsonfeedToAtom, mustache } from "./deps.ts";
import { fs, path } from "./deps.ts";
import {
  DayInfo,
  FeedInfo,
  File,
  FileInfo,
  FileMetaWithSource,
  Item,
  List,
  ListItem,
  RunOptions,
  WeekOfYear,
} from "./interface.ts";
import renderMarkdown from "./render-markdown.ts";
import {
  exists,
  formatHumanTime,
  formatNumber,
  getBaseFeed,
  getDayNumber,
  getDbIndex,
  getDbMeta,
  getDistRepoContentPath,
  getDistRepoGitUrl,
  getDistRepoPath,
  getIndexFileConfig,
  getnextPaginationTextByNumber,
  getPaginationHtmlByNumber,
  getPaginationTextByNumber,
  getPublicPath,
  getRepoHTMLURL,
  getStaticPath,
  getWeekNumber,
  pathnameToFeedUrl,
  pathnameToFilePath,
  pathnameToUrl,
  readTextFile,
  slug,
  walkFile,
  writeDbMeta,
  writeJSONFile,
  writeTextFile,
} from "./util.ts";
import log from "./log.ts";
import { getItemsByDays, getUpdatedDays, getUpdatedFiles } from "./db.ts";
import buildBySource from "./build-by-source.ts";

export default async function buildMarkdown(options: RunOptions) {
  const config = options.config;
  const sourcesConfig = config.sources;
  const siteConfig = config.site;
  const sourcesKeys = Object.keys(sourcesConfig);
  const isBuildSite = options.html;
  const specificSourceIdentifiers = options.sourceIdentifiers;
  const isBuildMarkdown = options.markdown;
  const now = new Date();
  if (!isBuildSite && !isBuildMarkdown) {
    log.info("skip build site or markdown");
    return;
  }

  const dbMeta = await getDbMeta();
  const dbIndex = await getDbIndex();
  const dbSources = dbMeta.sources;

  let dbSourcesKeys = Object.keys(dbSources);
  // delete all dbMeta item that does not exist in config
  // compare sources keys and dbSourcesKeys
  const dbSourcesKeysToDelete = dbSourcesKeys.filter(
    (key) => !sourcesKeys.includes(key),
  );
  dbSourcesKeysToDelete.forEach((key) => {
    log.info(`delete source ${key} from dbMeta`);
    delete dbSources[key];
  });
  dbSourcesKeys = Object.keys(dbSources);

  let dbItemsLatestUpdatedAt = new Date(0);
  const htmlIndexTemplateContent = await readTextFile(
    "./templates/index.html.mu",
  );

  for (const sourceIdentifier of dbSourcesKeys) {
    const source = dbSources[sourceIdentifier];
    const files = source.files;
    for (const fileKey of Object.keys(files)) {
      const file = files[fileKey];
      if (
        new Date(file.updated_at).getTime() > dbItemsLatestUpdatedAt.getTime()
      ) {
        dbItemsLatestUpdatedAt = new Date(file.updated_at);
      }
    }
  }
  const startTime = new Date();
  log.info("start build markdown at " + startTime);
  // get last update time
  let lastCheckedAt = dbMeta.checked_at;
  if (options.force) {
    lastCheckedAt = "1970-01-01T00:00:00.000Z";
  }
  let allUpdatedFiles: File[] = [];
  if (specificSourceIdentifiers.length > 0) {
    // build specific source
    for (const sourceIdentifier of specificSourceIdentifiers) {
      const sourceConfig = sourcesConfig[sourceIdentifier];
      if (!sourceConfig) {
        log.error(`source ${sourceIdentifier} not found`);
        continue;
      }
      const sourceFilesKeys = Object.keys(sourceConfig.files);
      for (const file of sourceFilesKeys) {
        allUpdatedFiles.push({
          source_identifier: sourceIdentifier,
          file,
        });
      }
    }
  } else {
    // is any updates
    log.info(`check updates since ${lastCheckedAt}`);
    allUpdatedFiles = getUpdatedFiles({
      since_date: new Date(lastCheckedAt),
      source_identifiers: specificSourceIdentifiers,
    }, dbIndex);
  }
  if (options.limit && options.limit > 0) {
    allUpdatedFiles = allUpdatedFiles.slice(0, options.limit);
  }
  log.debug(
    `allUpdatedFiles (${allUpdatedFiles.length}) `,
  );
  if (allUpdatedFiles.length > 0) {
    log.info(`found ${allUpdatedFiles.length} updated files`);
    const dbSources = dbMeta.sources;
    const distRepoPath = getDistRepoPath();
    // is exist
    if (options.push) {
      let isExist = await exists(distRepoPath);
      // is exist, check is a git root dir
      if (isExist) {
        const isGitRootExist = await exists(path.join(distRepoPath, ".git"));
        if (!isGitRootExist) {
          // remote dir
          await Deno.remove(distRepoPath, {
            recursive: true,
          });
          isExist = false;
        }
      }
      if (!isExist) {
        // try to sync from remote
        log.info("cloning from remote...");
        const p = Deno.run({
          cmd: ["git", "clone", getDistRepoGitUrl(), distRepoPath],
        });

        await p.status();
      } else {
        log.info(`dist repo already exist, skip updates`);
        // try to sync
        const p = Deno.run({
          cmd: [
            "git",
            "--git-dir",
            path.join(distRepoPath, ".git"),
            "--work-tree",
            distRepoPath,
            "pull",
          ],
        });

        await p.status();
      }
    }

    if (options.cleanMarkdown) {
      log.info("clean markdown files");
      // remove all dist repo path files, except .git
      const walker = await walkFile(distRepoPath);
      for await (const entry of walker) {
        const relativePath = path.relative(distRepoPath, entry.path);
        if (relativePath.startsWith(".git")) {
          continue;
        } else {
          await Deno.remove(entry.path);
        }
      }
    }
    if (options.cleanHtml) {
      log.info("clean html files");
      // remove all dist repo path files, except .git
      await Deno.remove(getPublicPath(), {
        recursive: true,
      });
    }

    const htmlTemplate = await readTextFile("./templates/index.html.mu");
    let commitMessage = "Automated update\n\n";
    // start to build
    log.info(
      "start to build sources markdown... total: " + allUpdatedFiles.length,
    );
    const startBuildSourceTime = new Date();
    let updatedFileIndex = 0;
    for (const file of allUpdatedFiles) {
      const sourceConfig = sourcesConfig[file.source_identifier];
      if (!sourceConfig || sourceConfig.skip) {
        log.error(`source ${file.source_identifier} not found`);
        continue;
      }
      const fileInfo: FileInfo = {
        sourceConfig: sourceConfig,
        sourceMeta: dbSources[sourceConfig.identifier],
        filepath: file.file,
      };
      updatedFileIndex++;
      log.info(
        `[${updatedFileIndex}/${allUpdatedFiles.length}] ${file.source_identifier}/${file.file}`,
      );
      const builtInfo = await buildBySource(
        fileInfo,
        options,
        {
          paginationHtml: "",
          dbMeta,
          paginationText: "",
          dbIndex,
        },
      );

      // commitMessage += builtInfo.commitMessage + "\n";
    }

    const endBuildSourceTime = new Date();
    const buildSourceTime = endBuildSourceTime.getTime() -
      startBuildSourceTime.getTime();
    log.info(
      "build single markdown done, cost ",
      (buildSourceTime / 1000).toFixed(2),
      " seconds",
    );

    const allFilesMeta: FileMetaWithSource[] = [];
    for (const sourceIdentifier of dbSourcesKeys) {
      const sourceMeta = dbSources[sourceIdentifier];
      const filesMeta = sourceMeta.files;
      const filesMetaKeys = Object.keys(filesMeta);
      for (const originalFilepath of filesMetaKeys) {
        const fileMeta = filesMeta[originalFilepath];
        allFilesMeta.push({
          ...fileMeta,
          sourceIdentifier,
          filepath: originalFilepath,
        });
      }
    }

    // write dbMeta
    dbMeta.checked_at = new Date().toISOString();

    // build week data
    // copy static files
    if (isBuildSite) {
      log.info("copy static files...");

      const staticPath = getStaticPath();

      // copy all files from static to public
      // walk files
      for await (const entry of await walkFile(staticPath)) {
        const relativePath = path.relative(staticPath, entry.path);
        const distPath = path.join(getPublicPath(), relativePath);
        await fs.copy(entry.path, distPath, {
          overwrite: true,
        });
      }
    }

    const endTime = new Date();

    log.info(
      `build success, cost ${
        ((endTime.getTime() - startTime.getTime()) / 1000 / 60).toFixed(2)
      }ms`,
    );

    if (options.push) {
      // try to push updates
      log.info("start to push updates...");
      const p1 = Deno.run({
        cmd: [
          "git",
          "--git-dir",
          path.join(distRepoPath, ".git"),
          "--work-tree",
          distRepoPath,
          "add",
          ":/*.md",
        ],
      });
      await p1.status();

      const p2 = Deno.run({
        cmd: [
          "git",
          "-c",
          "user.name=github-actions[bot]",
          "-c",
          "user.email=github-actions[bot]@users.noreply.github.com",
          "--git-dir",
          path.join(distRepoPath, ".git"),
          "--work-tree",
          distRepoPath,
          "commit",
          "--author='github-actions[bot]  <github-actions[bot]@users.noreply.github.com>'",
          "-m",
          commitMessage,
        ],
      });
      await p2.status();
      const p3 = Deno.run({
        cmd: [
          "git",
          "--git-dir",
          path.join(distRepoPath, ".git"),
          "--work-tree",
          distRepoPath,
          "push",
        ],
      });
      await p3.status();
    } else {
      log.info("skip push updates...");
    }
  } else {
    log.info("no updated files, skip build markdown");
    // write dbMeta
    dbMeta.checked_at = new Date().toISOString();
  }
  writeDbMeta(dbMeta);
}
