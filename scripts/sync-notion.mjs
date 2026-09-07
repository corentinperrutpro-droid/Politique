import fs from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;

if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN manquant.");
if (!ROOT_PAGE_ID) throw new Error("NOTION_ROOT_PAGE_ID manquant.");

const OUTPUT_FILE = "data.js";
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 30000;
const MIN_REQUEST_GAP_MS = 350;
const MAX_DEPTH = 20;

let nextRequestAt = 0;
const childrenCache = new Map();

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForRequestSlot() {
  const now = Date.now();
  const startAt = Math.max(now, nextRequestAt);
  nextRequestAt = startAt + MIN_REQUEST_GAP_MS;
  if (startAt > now) await sleep(startAt - now);
}

async function notion(path) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForRequestSlot();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const response = await fetch(`https://api.notion.com/v1${path}`, {
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json"
        },
        signal: controller.signal
      });

      clearTimeout(timeout);
      if (response.ok) return response.json();

      const text = await response.text();
      const retryAfter = Number(response.headers.get("retry-after"));
      if (response.status !== 429 && response.status < 500) {
        throw new Error(`Notion API ${response.status} sur ${path}: ${text}`);
      }

      if (attempt >= MAX_RETRIES) {
        throw new Error(`Notion API ${response.status} après ${MAX_RETRIES} tentatives sur ${path}: ${text}`);
      }

      const base = response.status === 429 ? 30000 : 5000;
      const cap = response.status === 429 ? 180000 : 60000;
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? retryAfter * 1000
        : Math.min(base * 2 ** attempt, cap);
      console.log(`Notion API ${response.status} sur ${path} — nouvelle tentative dans ${Math.round(waitMs / 1000)}s.`);
      await sleep(waitMs);
    } catch (error) {
      clearTimeout(timeout);
      if (error?.message?.startsWith("Notion API ")) throw error;
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Erreur réseau Notion après ${MAX_RETRIES} tentatives sur ${path}: ${error?.message || error}`);
      }
      const waitMs = Math.min(2000 * 2 ** attempt, 30000);
      console.log(`Erreur réseau Notion sur ${path} — nouvelle tentative dans ${Math.round(waitMs / 1000)}s.`);
      await sleep(waitMs);
    }
  }
}

async function getChildren(blockId) {
  if (childrenCache.has(blockId)) return childrenCache.get(blockId);
  const promise = (async () => {
    const results = [];
    let cursor = null;
    do {
      const params = new URLSearchParams({ page_size: "100" });
      if (cursor) params.set("start_cursor", cursor);
      const data = await notion(`/blocks/${blockId}/children?${params}`);
      results.push(...(data.results || []));
      cursor = data.has_more ? data.next_cursor : null;
    } while (cursor);
    return results;
  })();
  childrenCache.set(blockId, promise);
  return promise;
}

function richTextToPlain(richText = []) {
  return richText.map(item => item?.plain_text || "").join("").trim();
}

function cleanTitle(title = "") {
  return title.replace(/\s+/g, " ").trim();
}

function childPageTitle(block) {
  return cleanTitle(block.child_page?.title || "");
}

function parseNumberedTitle(title) {
  const match = cleanTitle(title).match(/^\s*(\d+)\.(?:\s+)?(.+)$/u);
  return match ? { number: Number(match[1]), title: match[2].trim() } : null;
}

function pageTitleFromBlocks(blocks) {
  const titleBlock = blocks.find(block => block.type === "child_page");
  return titleBlock ? childPageTitle(titleBlock) : "";
}

async function getPageTitle(pageId) {
  const data = await notion(`/pages/${pageId}`);
  const property = Object.values(data.properties || {}).find(p => p.type === "title");
  return richTextToPlain(property?.title || []);
}

async function buildNode(pageId, title, parentId, depth, path = []) {
  if (depth > MAX_DEPTH) throw new Error(`Profondeur maximale dépassée (${MAX_DEPTH}) sur ${pageId}.`);

  const blocks = await getChildren(pageId);
  const childPages = blocks.filter(block => block.type === "child_page");
  const node = {
    id: pageId,
    title: cleanTitle(title),
    parentId,
    depth,
    path: [...path, cleanTitle(title)],
    children: []
  };

  if (!childPages.length) {
    node.type = "fiche";
    node.content = await renderBlocks(blocks);
    return node;
  }

  node.type = "folder";
  // Les branches sont construites en parallèle, mais chaque enfant conserve
  // explicitement son parent. On ne reconstruit jamais la hiérarchie à partir
  // d'une liste globale dont l'ordre pourrait changer.
  node.children = await Promise.all(childPages.map(child =>
    buildNode(child.id, childPageTitle(child), pageId, depth + 1, node.path)
  ));

  return node;
}

function blockRichText(block) {
  const value = block[block.type];
  return value ? richTextToPlain(value.rich_text || []) : "";
}

async function renderBlocks(blocks) {
  const output = [];
  for (const block of blocks) {
    const type = block.type;
    const text = blockRichText(block);

    if (["paragraph", "heading_1", "heading_2", "heading_3", "quote", "callout"].includes(type)) {
      if (text) output.push(text);
    } else if (type === "bulleted_list_item" || type === "numbered_list_item") {
      if (text) output.push(`• ${text}`);
    } else if (type === "to_do") {
      if (text) output.push(`${block.to_do?.checked ? "☑" : "☐"} ${text}`);
    } else if (type === "divider") {
      output.push("---");
    } else if (type === "code" && text) {
      output.push(text);
    }

    if (block.has_children) {
      const children = await getChildren(block.id);
      const nested = await renderBlocks(children);
      if (nested) output.push(nested);
    }
  }
  return output.join("\n\n").trim();
}

function flattenFiches(node, ancestors = [], result = []) {
  const nextAncestors = [...ancestors, node];
  if (node.type === "fiche") {
    const numbered = [...nextAncestors].reverse().find(item => parseNumberedTitle(item.title));
    const theme = nextAncestors.find(item => item.depth === 1 && parseNumberedTitle(item.title));
    result.push({
      id: node.id,
      titre: node.title,
      html: node.content || "",
      path: node.path,
      theme: theme ? parseNumberedTitle(theme.title)?.number : null,
      cat: numbered ? cleanTitle(numbered.title).split(/\s+/u)[0] : ""
    });
    return result;
  }
  for (const child of node.children || []) flattenFiches(child, nextAncestors, result);
  return result;
}

function countNodes(node) {
  return 1 + (node.children || []).reduce((sum, child) => sum + countNodes(child), 0);
}

function maxDepth(node) {
  return Math.max(node.depth, ...(node.children || []).map(maxDepth));
}

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Lecture récursive de l'arborescence réelle depuis la page racine...");

const rootTitle = cleanTitle(await getPageTitle(ROOT_PAGE_ID));
const root = {
  id: ROOT_PAGE_ID,
  title: rootTitle,
  parentId: null,
  depth: 0,
  path: [rootTitle],
  type: "root",
  children: []
};

const rootBlocks = await getChildren(ROOT_PAGE_ID);
const rootPages = rootBlocks.filter(block => block.type === "child_page");
root.children = await Promise.all(rootPages.map(child =>
  buildNode(child.id, childPageTitle(child), ROOT_PAGE_ID, 1, [rootTitle])
));

const themes = root.children
  .filter(node => parseNumberedTitle(node.title))
  .sort((a, b) => (parseNumberedTitle(a.title).number - parseNumberedTitle(b.title).number));

const fiches = themes.flatMap(theme => flattenFiches(theme));
const totalNodes = themes.reduce((sum, theme) => sum + countNodes(theme), 0);
const deepest = themes.length ? Math.max(...themes.map(maxDepth)) : 0;

console.log(`📄 Nœuds sous la racine : ${root.children.length}`);
console.log(`🏛️ Thèmes détectés : ${themes.length}`);
console.log(`📝 Fiches terminales détectées : ${fiches.length}`);
console.log(`🧭 Nœuds structurants : ${totalNodes}`);
console.log(`↕️ Profondeur maximale : ${deepest}`);

if (!themes.length) throw new Error("Aucun thème numéroté détecté. data.js ne sera PAS modifié.");
if (!fiches.length) throw new Error("Aucune fiche terminale détectée. data.js ne sera PAS modifié.");

const emptyContent = fiches.filter(fiche => !fiche.html).length;
console.log(`📦 Fiches avec contenu : ${fiches.length - emptyContent}/${fiches.length}`);
if (emptyContent > 0) console.log(`⚠️ ${emptyContent} fiches ont un contenu vide.`);

const output = `// Données générées depuis Notion — ne pas modifier manuellement.\nconst SITE_DATA = ${JSON.stringify({ root, themes, fiches }, null, 2)};\n`;
await fs.writeFile(OUTPUT_FILE, output, "utf8");
console.log(`\n✅ ${OUTPUT_FILE} généré avec succès : ${fiches.length} fiches terminales.`);
