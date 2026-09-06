#!/usr/bin/env node
/**
 * Synchronise récursivement un arbre Notion vers data.js pour le site statique.
 *
 * Prérequis :
 *   NOTION_TOKEN   token d'une intégration Notion ayant accès à la page racine
 *   NOTION_ROOT_ID ID de la page « DOCUMENTATION POLITIQUE — Base de Décision d'État »
 *
 * Usage : node scripts/sync-notion.mjs
 */
import fs from "node:fs/promises";

const token = process.env.NOTION_TOKEN;
const rootId = process.env.NOTION_ROOT_ID;
const apiVersion = "2022-06-28";

if (!token || !rootId) {
  console.error("NOTION_TOKEN et NOTION_ROOT_ID sont requis.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Notion-Version": apiVersion,
  "Content-Type": "application/json"
};

async function notion(path) {
  const response = await fetch(`https://api.notion.com/v1${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion API ${response.status} ${path}: ${body.slice(0, 500)}`);
  }
  return response.json();
}

async function allChildren(blockId) {
  const result = [];
  let cursor;
  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (cursor) query.set("start_cursor", cursor);
    const page = await notion(`/blocks/${blockId}/children?${query}`);
    result.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return result;
}

function richText(items = []) {
  return items.map((item) => {
    let text = item.plain_text ?? item.text?.content ?? "";
    if (item.annotations?.code) text = `<code>${escapeHtml(text)}</code>`;
    else if (item.annotations?.bold) text = `<strong>${escapeHtml(text)}</strong>`;
    else if (item.annotations?.italic) text = `<em>${escapeHtml(text)}</em>`;
    else text = escapeHtml(text);
    if (item.href) text = `<a href="${escapeAttr(item.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    return text;
  }).join("");
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\\\"": "&quot;" }[c]));
}

function escapeAttr(value = "") {
  return escapeHtml(value).replace(/'/g, "&#39;");
}

function blockToHtml(block) {
  const type = block.type;
  const data = block[type] || {};
  const text = richText(data.rich_text);
  if (type === "paragraph") return text ? `<p>${text}</p>` : "";
  if (type === "heading_1") return `<h2>${text}</h2>`;
  if (type === "heading_2") return `<h3>${text}</h3>`;
  if (type === "heading_3") return `<h4>${text}</h4>`;
  if (type === "quote") return `<blockquote>${text}</blockquote>`;
  if (type === "callout") return `<aside class="callout">${text}</aside>`;
  if (type === "bulleted_list_item") return `<li>${text}</li>`;
  if (type === "numbered_list_item") return `<li>${text}</li>`;
  if (type === "to_do") return `<p class="todo">${data.checked ? "☑" : "☐"} ${text}</p>`;
  if (type === "code") return `<pre><code>${escapeHtml(data.code?.map?.(x => x.plain_text).join("") ?? "")}</code></pre>`;
  if (type === "divider") return "<hr>";
  if (type === "table_of_contents") return "";
  if (type === "bookmark" || type === "link_preview") {
    const url = data.url || data.link_preview?.url;
    return url ? `<p><a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a></p>` : "";
  }
  if (type === "image") {
    const url = data.type === "external" ? data.external?.url : data.file?.url;
    return url ? `<figure><img loading="lazy" src="${escapeAttr(url)}" alt=""><figcaption>${text}</figcaption></figure>` : "";
  }
  return text ? `<p>${text}</p>` : "";
}

async function renderBlocks(blocks) {
  const html = [];
  let bullets = [];
  let numbers = [];
  const flush = () => {
    if (bullets.length) html.push(`<ul>${bullets.join("")}</ul>`), bullets = [];
    if (numbers.length) html.push(`<ol>${numbers.join("")}</ol>`), numbers = [];
  };

  for (const block of blocks) {
    if (block.type === "bulleted_list_item") { numbers.length && flush(); bullets.push(blockToHtml(block)); continue; }
    if (block.type === "numbered_list_item") { bullets.length && flush(); numbers.push(blockToHtml(block)); continue; }
    flush();
    let rendered = blockToHtml(block);
    if (block.has_children) {
      const children = await allChildren(block.id);
      const childHtml = await renderBlocks(children);
      rendered += childHtml;
    }
    html.push(rendered);
  }
  flush();
  return html.join("\n");
}

const seen = new Set();
async function crawlPage(pageId, parentId = null, depth = 0) {
  const normalized = pageId.replace(/-/g, "");
  if (seen.has(normalized)) return null;
  seen.add(normalized);

  const page = await notion(`/pages/${normalized}`);
  const title = page.properties?.title?.title?.map((x) => x.plain_text).join("")
    || Object.values(page.properties || {}).find((p) => p.type === "title")?.title?.map((x) => x.plain_text).join("")
    || "Sans titre";
  const blocks = await allChildren(normalized);
  const html = await renderBlocks(blocks);

  const node = {
    id: normalized,
    title,
    url: `https://www.notion.so/${normalized}`,
    parentId,
    depth,
    lastEditedTime: page.last_edited_time,
    html
  };

  const childPages = [];
  for (const block of blocks) {
    if (block.type === "child_page") childPages.push(block.id);
  }
  node.children = [];
  for (const childId of childPages) {
    const child = await crawlPage(childId, normalized, depth + 1);
    if (child) node.children.push(child.id);
  }
  return node;
}

const root = await crawlPage(rootId);
const pages = [];
for (const id of seen) {
  // Le second passage n'est pas nécessaire : crawlPage alimente la structure via un index ci-dessous.
}

// Reconstruit un index à partir d'un crawl déterministe en une seule passe.
const records = [];
async function collect(id, parentId = null, depth = 0) {
  const page = await notion(`/pages/${id}`);
  const title = Object.values(page.properties || {}).find((p) => p.type === "title")?.title?.map((x) => x.plain_text).join("") || "Sans titre";
  const blocks = await allChildren(id);
  records.push({
    id,
    title,
    url: `https://www.notion.so/${id}`,
    parentId,
    depth,
    lastEditedTime: page.last_edited_time,
    html: await renderBlocks(blocks)
  });
  for (const block of blocks) if (block.type === "child_page") await collect(block.id, id, depth + 1);
}

seen.clear();
await collect(rootId.replace(/-/g, ""));

const payload = {
  generatedAt: new Date().toISOString(),
  source: "Notion",
  rootId: rootId.replace(/-/g, ""),
  pages: records,
  themes: records
    .filter((p) => p.parentId === rootId.replace(/-/g, ""))
    .map((p, i) => ({ num: i + 1, titre: p.title, emoji: "", notionId: p.id, statut: "Synchronisé depuis Notion", fiches: 0, categories: [], pageId: p.id }))
};

const output = `// Généré automatiquement depuis Notion — ne pas modifier à la main.\nconst SITE_DATA = ${JSON.stringify(payload)};\n`;
await fs.mkdir(".", { recursive: true });
await fs.writeFile("data.js", output, "utf8");
console.log(`Synchronisation terminée : ${records.length} pages.`);
