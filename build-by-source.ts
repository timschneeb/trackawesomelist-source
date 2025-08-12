import {
  CSS,
  groupBy,
  jsonfeedToAtom,
  mustache,
  path,
  render,
} from "./deps.ts";
import {
  BuildOptions,
  BuiltMarkdownInfo,
  DayInfo,
  Feed,
  FeedInfo,
  FeedItem,
  FileInfo,
  Item,
  Nav,
  RunOptions,
  WeekOfYear,
} from "./interface.ts";
import {
  CONTENT_DIR,
  FEED_NAV,
  HOME_NAV,
  INDEX_HTML_PATH,
  INDEX_MARKDOWN_PATH,
  SEARCH_NAV,
  SPONSOR_NAV,
  SPONSOR_URL,
  SUBSCRIBE_NAV,
  SUBSCRIPTION_URL,
} from "./constant.ts";
import {
  formatHumanTime,
  formatNumber,
  getBaseFeed,
  getDistRepoContentPath,
  getDomain,
  getPublicPath,
  getRepoHTMLURL,
  nav1ToHtml,
  nav1ToMarkdown,
  nav2ToHtml,
  nav2ToMarkdown,
  parseDayInfo,
  parseWeekInfo,
  pathnameToFeedUrl,
  pathnameToFilePath,
  pathnameToOverviewFilePath,
  pathnameToUrl,
  pathnameToWeekFilePath,
  readTextFile,
  relativedFilesToHtml,
  relativedFilesToMarkdown,
  slugy,
  startDateOfWeek,
  writeJSONFile,
  writeTextFile,
} from "./util.ts";
import log from "./log.ts";
import { getFile, getHtmlFile, getItems } from "./db.ts";
import renderMarkdown from "./render-markdown.ts";
let htmlIndexTemplateContent = "";
export default async function main(
  fileInfo: FileInfo,
  runOptions: RunOptions,
  buildOptions: BuildOptions,
): Promise<BuiltMarkdownInfo> {
  const config = runOptions.config;
  const siteConfig = config.site;
  const dbMeta = buildOptions.dbMeta;
  const dbSources = dbMeta.sources;
  const sourceConfig = fileInfo.sourceConfig;
  const sourceCategory = sourceConfig.category;
  const sourceMeta = fileInfo.sourceMeta;
  const filepath = fileInfo.filepath;
  const fileConfig = sourceConfig.files[filepath];
  const repoMeta = sourceMeta.meta;
  const sourceIdentifier = sourceConfig.identifier;
  const dbSource = dbSources[sourceIdentifier];
  const originalFilepath = fileConfig.filepath;
  let commitMessage = ``;
  const sourceFileConfig = fileConfig;
  // get items

  const items = await getItems(sourceIdentifier, originalFilepath);
  // const getDbFinishTime = Date.now();
  // log.debug(`get db items cost ${getDbFinishTime - startTime}ms`);
  const dbFileMeta = dbSource.files[originalFilepath];
  const domain = getDomain();
  const isBuildMarkdown = runOptions.markdown;
  const isBuildHtml = runOptions.html;
  if (!isBuildMarkdown && !isBuildHtml) {
    return {
      commitMessage: "",
    };
  }
  if (!htmlIndexTemplateContent) {
    htmlIndexTemplateContent = await readTextFile("./templates/index.html.mu");
  }
  let relativeFolder = sourceIdentifier;
  if (!sourceFileConfig.index) {
    // to README.md path
    const filepathExtname = path.extname(originalFilepath);
    const originalFilepathWithoutExt = originalFilepath.slice(
      0,
      -filepathExtname.length,
    );
    relativeFolder = path.join(relativeFolder, originalFilepathWithoutExt);
  }
  const baseFeed = getBaseFeed();
  for (let i = 0; i < 1; i++) {
    const buildMarkdownStartTime = Date.now();
    const isDay = true;

    let relatedFiles: Nav[] = [];
    if (sourceFileConfig.index && Object.keys(sourceConfig.files).length > 1) {
      const files = sourceConfig.files;
      const fileKeys = Object.keys(files).filter((key) => {
        return key !== originalFilepath;
      });
      relatedFiles = fileKeys.map((fileKey) => {
        const file = files[fileKey];
        return {
          name: file.name,
          markdown_url: "README.md",
          url: "README.md",
        };
      });
    }

    const feedTitle = `Recent ${fileConfig.name} updates`;
    const feedDescription = repoMeta.description;
    const groups = groupBy(
      items,
      "updated_day",
    ) as Record<
      string,
      Item[]
    >;
    const groupKeys = Object.keys(groups);
    // sort
    groupKeys.sort((a: string, b: string) => {
      if (isDay) {
        return parseDayInfo(Number(b)).date.getTime() -
          parseDayInfo(Number(a)).date.getTime();
      } else {
        return parseWeekInfo(Number(b)).date.getTime() -
          parseWeekInfo(Number(a)).date.getTime();
      }
    });

    const dailyRelativeFolder = relativeFolder;

    let feedItems: FeedItem[] = groupKeys.map((key) => {
      const groupItems = groups[key];
      const categoryGroup = groupBy(groupItems, "category") as Record<
        string,
        Item[]
      >;
      let groupMarkdown = "";
      let groupHtml = "";
      let summary = "";
      const categoryKeys: string[] = Object.keys(categoryGroup);
      const today = new Date();
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);
      let datePublished: Date = tomorrow;
      let dateModified: Date = new Date(0);
      let total = 0;
      categoryKeys.forEach((key: string) => {
        const categoryItem = categoryGroup[key][0];
        if (key) {
          groupMarkdown += `\n\n### ${key}\n`;
          groupHtml += `<h3>${categoryItem.category_html}</h3>`;
        } else {
          groupMarkdown += `\n`;
        }
        categoryGroup[key].forEach((item) => {
          total++;
          groupMarkdown += `\n${item.markdown}`;
          groupHtml += `\n${item.html}`;
          const itemUpdatedAt = new Date(item.updated_at);
          if (itemUpdatedAt.getTime() > dateModified.getTime()) {
            dateModified = itemUpdatedAt;
          }
          if (itemUpdatedAt.getTime() < datePublished.getTime()) {
            datePublished = itemUpdatedAt;
          }
        });
      });
      let dayInfo: DayInfo | WeekOfYear;
      if (isDay) {
        dayInfo = parseDayInfo(Number(key));
      } else {
        dayInfo = parseWeekInfo(Number(key));
      }
      summary = `${total} project(s) updated on ${dayInfo.name}`;
      const slug = dayInfo.path + "/";
      const itemUrl = `${domain}/${dayInfo.path}/`;
      const url = `${domain}/${slug}`;
      const feedItem: FeedItem = {
        id: itemUrl,
        title: `${fileConfig.name} updates on ${dayInfo.name}`,
        _short_title: dayInfo.name,
        _slug: slug,
        summary,
        _filepath: pathnameToFilePath("/" + slug),
        url: "",
        date_published: datePublished.toISOString(),
        date_modified: dateModified.toISOString(),
        content_text: groupMarkdown,
        content_html: groupHtml,
      };
      return feedItem;
    });

    // sort feedItems by date published
    feedItems.sort((a, b) => {
      const aDate = new Date(a.date_published);
      const bDate = new Date(b.date_published);
      return bDate.getTime() - aDate.getTime();
    });

    const feedSeoTitle =
      `Recent ${fileConfig.name} (${sourceIdentifier}) updates`;
    const feedInfo: FeedInfo = {
      ...baseFeed,
      title: feedTitle,
      _seo_title: `${feedSeoTitle} - ${siteConfig.title}`,
      _site_title: siteConfig.title,
      description: "Recent additions and updates to the [awesome-shizuku list](https://github.com/timschneeb/awesome-shizuku). This overview is updated automatically and contains the latest changes, grouped by date. Please note that changes to existing entries are also considered 'new' and get bumped to the top.",
      home_page_url: `${domain}/${dailyRelativeFolder}/`,
      feed_url: `${domain}/${dailyRelativeFolder}/feed.json`,
    };
    const feed: Feed = {
      ...feedInfo,
      items: feedItems,
    };
    const markdownDoc = `# ${feed.title}${
      feed.description ? `\n\n${feed.description}` : ""
    }

${relativedFilesToMarkdown(relatedFiles)}${
      feedItems.map((item) => {
        // Hide entries older than 1 year
        if((Date.now() - new Date(item.date_modified).getTime()) / (1000 * 3600 * 24 * 365) <= 1)
        return `\n\n## ${item._short_title}${item.content_text}`;
      }).join("")
    }

## Older than 1 year

This changelog only contains entries modified within the last year. If you want to see older entries.

View the full list at [awesome-shizuku](https://github.com/timschneeb/awesome-shizuku).

_________________


The changelog generator is based on [my fork of trackawesomelist](https://github.com/timschneeb/trackawesomelist-source/tree/shizuku-tracking).
    `;
    if (isBuildMarkdown) {
      const markdownDistPath = path.join(
        getDistRepoContentPath(),
        dailyRelativeFolder,
        INDEX_MARKDOWN_PATH,
      );
      await writeTextFile(markdownDistPath, markdownDoc);
      const writeMarkdownTime = Date.now();
      log.debug(
        `build ${markdownDistPath} success, cost ${
          writeMarkdownTime - buildMarkdownStartTime
        }ms`,
      );
    }
    // build html
    if (isBuildHtml) {
      // add body, css to feed
      // const body = renderMarkdown(markdownDoc);

      const body = `<h1>${feed.title}</h1>
${feed.description ? "<p>" + feed.description + "</p>" : ""}
${relativedFilesToHtml(relatedFiles)}
${
        feedItems.map((item) => {
          return `<h2><a href="${item.url}">${item._short_title}</a></h2>${item.content_html}`;
        }).join("")
      }`;
      const htmlDoc = mustache.render(htmlIndexTemplateContent, {
        ...feedInfo,
        body,
        CSS,
      });
      const htmlDistPath = path.join(
        getPublicPath(),
        dailyRelativeFolder,
        INDEX_HTML_PATH,
      );
      await writeTextFile(htmlDistPath, htmlDoc);
      log.debug(`build ${htmlDistPath} success`);

      // build feed json
      const feedJsonDistPath = path.join(
        getPublicPath(),
        dailyRelativeFolder,
        "feed.json",
      );
      // remote the current day feed, cause there is maybe some new items

      if (isDay) {
        // today start
        const today = new Date();
        const todayStart = new Date(
          today.getUTCFullYear(),
          today.getUTCMonth(),
          today.getUTCDate(),
        );
        const todayStartTimestamp = todayStart.getTime();
        feedItems = feedItems.filter((item) => {
          const itemDate = new Date(item.date_published);
          return itemDate.getTime() < todayStartTimestamp;
        });
      } else {
        // week
        // get week start date
        const startWeekDate = startDateOfWeek(new Date());
        const startWeekDateTimestamp = startWeekDate.getTime();
        feedItems = feedItems.filter((item) => {
          const itemDate = new Date(item.date_published);
          return itemDate.getTime() < startWeekDateTimestamp;
        });
      }
      feed.items = feedItems;

      await writeJSONFile(feedJsonDistPath, feed);
      // build rss
      const rssFeed = { ...feed };
      rssFeed.items = rssFeed.items.map(({ content_text: _, ...rest }) => rest);
      // @ts-ignore: node modules
      const feedOutput = jsonfeedToAtom(rssFeed, {
        language: "en",
      });
      const rssDistPath = path.join(
        getPublicPath(),
        dailyRelativeFolder,
        "rss.xml",
      );
      await writeTextFile(rssDistPath, feedOutput);
    }
  }

  return {
    commitMessage,
  };
}
