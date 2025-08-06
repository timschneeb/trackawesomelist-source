import {
  DocItem,
  ExpiredValue,
  FileInfo,
  ParseOptions,
} from "../../interface.ts";
import {
  Content,
  fromMarkdown,
  gfm,
  gfmFromMarkdown,
  gfmToMarkdown,
  Link,
  remarkInlineLinks,
  toMarkdown,
  visit,
} from "../../deps.ts";
import { childrenToRoot, getRepoHTMLURL, promiseLimit } from "../../util.ts";
import log from "../../log.ts";
import formatMarkdownItem from "../../format-markdown-item.ts";
import formatCategory from "../../format-category.ts";
import { uglyFormatItemIdentifier } from "./util.ts";
export default function (
  content: string,
  fileInfo: FileInfo,
  dbCachedStars: Record<string, ExpiredValue>,
): Promise<DocItem[]> {
  const sourceConfig = fileInfo.sourceConfig;
  const fileConfig = sourceConfig.files[fileInfo.filepath];
  const parseOptions = fileConfig.options;
  const isParseCategory = parseOptions.is_parse_category === undefined
    ? true
    : parseOptions.is_parse_category;
  const items: DocItem[] = [];
  const tree = fromMarkdown(content, "utf8", {
    extensions: [gfm()],
    mdastExtensions: [gfmFromMarkdown()],
  });
  // transform inline links to link
  // @ts-ignore: remarkInlineLinks is not typed
  remarkInlineLinks()(tree);
  let index = 0;
  let currentLevel = 0;
  let currentSubCategory = "";
  let currentCategory = "";
  let lowestHeadingLevel = 3;
  // first check valided sections
  const validSections: Content[] = [];
  let isReachedValidSection = false;
  const max_heading_level = parseOptions.max_heading_level || 2;
  for (const rootNode of tree.children) {
    // start with the first valid ma  x_heading_level

    if (!isReachedValidSection) {
      // check is valid now
      if (
        rootNode.type === "heading" &&
        rootNode.depth === max_heading_level
      ) {
        isReachedValidSection = true;
      } else {
        continue;
      }
    }

    if (rootNode.type === "heading") {
      currentLevel = rootNode.depth;

      if (
        currentLevel > lowestHeadingLevel
      ) {
        lowestHeadingLevel = currentLevel;
      }
      validSections.push(rootNode);
    } else if (rootNode.type === "list") {
      // check if all links is author link
      // if so, it's a table of content
      // ignore it
      let internalLinkCount = 0;
      let externalLinkCount = 0;
      visit(childrenToRoot(rootNode.children), "link", (node: { url: string; }) => {
        if (!node.url.startsWith("#")) {
          internalLinkCount++;
        } else {
          externalLinkCount++;
        }
      });
      // for fix some repo's toc include a little external links
      // we still treat it as toc if internal link count is more than 80%
      // for example: https://github.com/EbookFoundation/free-programming-books/blob/main/books/free-programming-books-langs.md#bootstrap
      if (
        externalLinkCount === 0 ||
        (internalLinkCount > 10 && externalLinkCount < 2)
      ) {
        validSections.push(rootNode);
      }
    }
  }
  const min_heading_level = parseOptions.min_heading_level ||
    lowestHeadingLevel;
  const funcs: (() => Promise<DocItem>)[] = [];

  const categoryHierarchy: string[] = [];

  for (const rootNode of validSections) {
    if (rootNode.type === "heading") {
      currentLevel = rootNode.depth;

      if (
        currentLevel <= min_heading_level && currentLevel >= max_heading_level
      ) {
        console.log(currentLevel - max_heading_level, "; ", formatCategory(
            childrenToRoot(rootNode.children),
          ))

        // Remove higher levels
        categoryHierarchy.splice(currentLevel - max_heading_level);

        // Replace level with current
        categoryHierarchy.splice(currentLevel - max_heading_level, 0, formatCategory(
            childrenToRoot(rootNode.children),
          ));
      }

      if (
        currentLevel < min_heading_level && currentLevel >= max_heading_level
      ) {
        currentCategory = formatCategory(
          childrenToRoot(rootNode.children),
        );
      } else if (currentLevel === min_heading_level) {
        currentSubCategory = formatCategory(
          childrenToRoot(rootNode.children),
        );
      }
    } else if (rootNode.type === "list") {
      for (const item of rootNode.children) {
        if (item.type === "listItem") {
          let category = categoryHierarchy.join(" / ").trim().replace(/\n/g, " ");
          const itemIdentifier = uglyFormatItemIdentifier(fileInfo, item);
          // console.log("itemIdentifier", itemIdentifier);
          if (uglyIsValidCategory(fileInfo, category)) {
            funcs.push(() => {
              return formatMarkdownItem(item, fileInfo, dbCachedStars).then(
                (formatedItem) => {
                  return {
                    formatedMarkdown: toMarkdown(formatedItem, {
                      extensions: [gfmToMarkdown()],
                    }).trim(),
                    rawMarkdown: itemIdentifier,
                    category: isParseCategory ? category : "",
                    line: item.position!.end.line,
                  };
                },
              );
            });
          }
        }
      }
    }
  }

  return promiseLimit<DocItem>(funcs);
}

function uglyIsValidCategory(
  fileInfo: FileInfo,
  category: string,
): boolean {
  const sourceConfig = fileInfo.sourceConfig;
  const fileConfig = sourceConfig.files[fileInfo.filepath];
  const sourceIdentifier = sourceConfig.identifier;
  if (sourceIdentifier === "KotlinBy/awesome-kotlin") {
    if (category.startsWith("Github Trending / ")) {
      return false;
    }
  }
  return true;
}
