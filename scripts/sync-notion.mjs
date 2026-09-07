import fs from "node:fs/promises";

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const ROOT_PAGE_ID = process.env.NOTION_ROOT_PAGE_ID;
if (!NOTION_TOKEN) throw new Error("NOTION_TOKEN manquant.");
if (!ROOT_PAGE_ID) throw new Error("NOTION_ROOT_PAGE_ID manquant.");

const OUTPUT_FILE = "data.js";
const MAX_RETRIES = 5;
const REQUEST_TIMEOUT_MS = 30000;
const MIN_REQUEST_GAP_MS = 350;
let nextRequestAt = 0;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitForSlot() {
  const now = Date.now();
  const at = Math.max(now, nextRequestAt);
  nextRequestAt = at + MIN_REQUEST_GAP_MS;
  if (at > now) await sleep(at - now);
}

async function notion(path, options = {}) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await waitForSlot();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`https://api.notion.com/v1${path}`, {
        ...options,
        headers: {
          Authorization: `Bearer ${NOTION_TOKEN}`,
          "Notion-Version": "2022-06-28",
          "Content-Type": "application/json",
          ...(options.headers || {})
        },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (response.ok) return response.json();
      const body = await response.text();
      if (response.status !== 429 && response.status < 500) throw new Error(`Notion API ${response.status}: ${body}`);
      if (attempt === MAX_RETRIES) throw new Error(`Notion API ${response.status} après ${MAX_RETRIES} tentatives`);
      const retryAfter = Number(response.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min((response.status === 429 ? 5000 : 2000) * 2 ** attempt, 60000);
      console.log(`⚠️ Notion ${response.status} — nouvelle tentative dans ${Math.ceil(wait / 1000)}s.`);
      await sleep(wait);
    } catch (error) {
      clearTimeout(timer);
      if (error.message?.startsWith("Notion API 4")) throw error;
      if (attempt === MAX_RETRIES) throw error;
      const wait = Math.min(1000 * 2 ** attempt, 30000);
      console.log(`⚠️ Erreur réseau — nouvelle tentative dans ${Math.ceil(wait / 1000)}s.`);
      await sleep(wait);
    }
  }
}

function titleOf(page) {
  const property = Object.values(page.properties || {}).find(p => p.type === "title");
  return (property?.title || []).map(x => x.plain_text || "").join("").replace(/\s+/g, " ").trim();
}
function parentIdOf(page) {
  const p = page.parent || {};
  return p.page_id || p.block_id || null;
}
function cleanId(id) { return String(id || "").replace(/-/g, ""); }
function sameId(a, b) { return cleanId(a) === cleanId(b); }

async function searchAllPages() {
  const pages = [];
  let cursor = undefined;
  do {
    const data = await notion("/search", { method: "POST", body: JSON.stringify({ page_size: 100, start_cursor: cursor, filter: { property: "object", value: "page" } }) });
    pages.push(...(data.results || []).filter(x => !x.in_trash));
    cursor = data.has_more ? data.next_cursor : undefined;
    console.log(`   ↳ ${pages.length} pages indexées...`);
  } while (cursor);
  return pages;
}

async function getChildren(id) {
  const out = [];
  let cursor;
  do {
    const q = new URLSearchParams({ page_size: "100" });
    if (cursor) q.set("start_cursor", cursor);
    const data = await notion(`/blocks/${id}/children?${q}`);
    out.push(...(data.results || []));
    cursor = data.has_more ? data.next_cursor : undefined;
  } while (cursor);
  return out;
}

function blockText(block) {
  const value = block[block.type];
  return (value?.rich_text || []).map(x => x.plain_text || "").join("").trim();
}
async function renderBlocks(blocks) {
  const lines = [];
  for (const block of blocks) {
    const text = blockText(block);
    if (["paragraph","heading_1","heading_2","heading_3","quote","callout"].includes(block.type) && text) lines.push(text);
    else if (["bulleted_list_item","numbered_list_item"].includes(block.type) && text) lines.push(`• ${text}`);
    else if (block.type === "to_do" && text) lines.push(`${block.to_do?.checked ? "☑" : "☐"} ${text}`);
    else if (block.type === "divider") lines.push("---");
    if (block.has_children) {
      const nested = await renderBlocks(await getChildren(block.id));
      if (nested) lines.push(nested);
    }
  }
  return lines.join("\n\n").trim();
}

console.log("🔄 Synchronisation Notion → site");
console.log("📚 Indexation unique des pages Notion et reconstruction locale de l'arborescence...");
const pages = await searchAllPages();
console.log(`📄 Pages trouvées : ${pages.length}`);

const byId = new Map(pages.map(p => [cleanId(p.id), { id: p.id, title: titleOf(p), parentId: parentIdOf(p), children: [], type: "folder" }]));
const rootKey = cleanId(ROOT_PAGE_ID);
const root = { id: ROOT_PAGE_ID, title: "Politique", parentId: null, children: [], type: "root" };
for (const node of byId.values()) {
  const parent = byId.get(cleanId(node.parentId));
  if (parent) parent.children.push(node);
  else if (sameId(node.parentId, ROOT_PAGE_ID)) root.children.push(node);
}

function sortTree(node) { node.children.sort((a,b) => a.title.localeCompare(b.title, "fr", {numeric:true})); node.children.forEach(sortTree); }
sortTree(root);
function prune(node) {
  node.children = node.children.filter(child => child.title).map(prune);
  node.type = node.children.length ? "folder" : "fiche";
  return node;
}
prune(root);
const themes = root.children;
console.log(`🏛️ Thèmes détectés sous la racine : ${themes.length}`);
if (!themes.length) throw new Error("Aucun enfant direct de la page racine détecté. data.js ne sera PAS modifié.");

const fiches = [];
function collect(node, path=[]) {
  const next = node.type === "root" ? path : [...path, node.title];
  if (node.type === "fiche") fiches.push({ id: node.id, titre: node.title, path: next, html: "" });
  else node.children.forEach(child => collect(child, next));
}
collect(root);
console.log(`📝 Fiches terminales détectées : ${fiches.length}`);
if (!fiches.length) throw new Error("Aucune fiche terminale détectée. data.js ne sera PAS modifié.");

console.log("📖 Lecture du contenu des fiches terminales...");
for (let i=0;i<fiches.length;i++) {
  fiches[i].html = await renderBlocks(await getChildren(fiches[i].id));
  if ((i+1)%25===0 || i+1===fiches.length) console.log(`   ↳ ${i+1}/${fiches.length} fiches lues...`);
}
const withContent = fiches.filter(f => f.html).length;
if (!withContent) throw new Error("Aucune fiche avec contenu. data.js ne sera PAS modifié.");

const output = `// Données générées depuis Notion — ne pas modifier manuellement.\nconst SITE_DATA = ${JSON.stringify({ root, themes, fiches }, null, 2)};\n`;
await fs.writeFile(OUTPUT_FILE, output, "utf8");
console.log(`✅ data.js généré : ${fiches.length} fiches, ${withContent} avec contenu.`);
