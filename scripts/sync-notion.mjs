#!/usr/bin/env node
/**
 * Exporte récursivement le dossier Politique Notion vers data.js.
 *
 * Variables requises : NOTION_TOKEN et NOTION_ROOT_ID.
 * Le token doit avoir accès à la page racine et à tous ses descendants.
 */
import fs from "node:fs/promises";

const token = process.env.NOTION_TOKEN;
const rootId = process.env.NOTION_ROOT_ID?.replace(/-/g, "");
if (!token || !rootId) {
  console.error("NOTION_TOKEN et NOTION_ROOT_ID sont requis.");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  "Notion-Version": "2022-06-28",
  "Content-Type": "application/json"
};

async function notion(path) {
  const response = await fetch(`https://api.notion.com/v1${path}`, { headers });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Notion API ${response.status} ${path}: ${body.slice(0, 800)}`);
  }
  return response.json();
}

async function allChildren(blockId) {
  const result = [];
  let cursor;
  do {
    const params = new URLSearchParams({ page_size: "100" });
    if (cursor) params.set("start_cursor", cursor);
    const page = await notion(`/blocks/${blockId}/children?${params}`);
    result.push(...page.results);
    cursor = page.has_more ? page.next_cursor : undefined;
  } while (cursor);
  return result;
}

function escapeHtml(value = "") {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value = "") {
  return escapeHtml(value);
}

function richText(items = []) {
  return items.map(item => {
    let text = escapeHtml(item.plain_text ?? item.text?.content ?? "");
    if (item.annotations?.code) text = `<code>${text}</code>`;
    else if (item.annotations?.bold) text = `<strong>${text}</strong>`;
    else if (item.annotations?.italic) text = `<em>${text}</em>`;
    if (item.href && /^(https?:|mailto:|#|\/)/i.test(item.href)) {
      text = `<a href="${escapeAttr(item.href)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    }
    return text;
  }).join("");
}

function blockToHtml(block) {
  const data = block[block.type] || {};
  const text = richText(data.rich_text);
  switch (block.type) {
    case "paragraph": return text ? `<p>${text}</p>` : "";
    case "heading_1": return `<h2>${text}</h2>`;
    case "heading_2": return `<h3>${text}</h3>`;
    case "heading_3": return `<h4>${text}</h4>`;
    case "quote": return `<blockquote>${text}</blockquote>`;
    case "callout": return `<aside class="callout">${text}</aside>`;
    case "bulleted_list_item": return `<li>${text}</li>`;
    case "numbered_list_item": return `<li>${text}</li>`;
    case "to_do": return `<p class="todo">${data.checked ? "☑" : "☐"} ${text}</p>`;
    case "code": return `<pre><code>${escapeHtml((data.rich_text || data.code || []).map(x => x.plain_text || "").join(""))}</code></pre>`;
    case "divider": return "<hr>";
    case "bookmark": return data.url ? `<p><a href="${escapeAttr(data.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(data.url)}</a></p>` : "";
    case "image": {
      const url = data.type === "external" ? data.external?.url : data.file?.url;
      return url ? `<figure><img loading="lazy" src="${escapeAttr(url)}" alt=""><figcaption>${text}</figcaption></figure>` : "";
    }
    default: return text ? `<p>${text}</p>` : "";
  }
}

async function renderBlocks(blocks) {
  const output = [];
  let listType = null;
  let listItems = [];

  const flush = () => {
    if (!listItems.length) return;
    output.push(`<${listType}>${listItems.join("")}</${listType}>`);
    listItems = [];
    listType = null;
  };

  for (const block of blocks) {
    const nextListType = block.type === "bulleted_list_item" ? "ul" : block.type === "numbered_list_item" ? "ol" : null;
    if (nextListType) {
      if (listType && listType !== nextListType) flush();
      listType = nextListType;
      let rendered = blockToHtml(block);
      if (block.has_children) rendered += await renderBlocks(await allChildren(block.id));
      listItems.push(rendered);
      continue;
    }
    flush();
    let rendered = blockToHtml(block);
    if (block.has_children) rendered += await renderBlocks(await allChildren(block.id));
    output.push(rendered);
  }
  flush();
  return output.filter(Boolean).join("\n");
}

const records = [];
const visited = new Set();

async function collect(pageId, parentId = null, depth = 0) {
  const id = pageId.replace(/-/g, "");
  if (visited.has(id)) return;
  visited.add(id);

  const page = await notion(`/pages/${id}`);
  const titleProperty = Object.values(page.properties || {}).find(p => p.type === "title");
  const title = titleProperty?.title?.map(x => x.plain_text).join("") || "Sans titre";
  const blocks = await allChildren(id);
  const html = await renderBlocks(blocks);

  records.push({
    id,
    title,
    url: `https://www.notion.so/${id}`,
    parentId,
    depth,
    lastEditedTime: page.last_edited_time,
    html
  });

  for (const block of blocks) {
    if (block.type === "child_page") await collect(block.id, id, depth + 1);
  }
}

await collect(rootId);

const root = records.find(p => p.id === rootId);
const themes = records
  .filter(p => p.parentId === rootId)
  .map((p, index) => ({
    num: index + 1,
    titre: p.title.replace(/^[^\p{L}\p{N}]*/u, "").replace(/^\d+\.\s*/, ""),
    emoji: p.title.match(/^\S+/u)?.[0] || "",
    notionId: p.id,
    statut: "Synchronisé depuis Notion",
    fiches: records.filter(x => x.parentId === p.id && x.depth >= 2).length,
    categories: [],
    pageId: p.id
  }));

const payload = {
  generatedAt: new Date().toISOString(),
  source: "Notion",
  rootId,
  rootTitle: root?.title || "DOCUMENTATION POLITIQUE",
  pages: records,
  themes,
  fiches: records
    .filter(p => p.depth >= 3)
    .map(p => ({ id: p.id, titre: p.title, html: p.html, notionId: p.id }))
};

await fs.writeFile(
  "data.js",
  `// Généré automatiquement depuis Notion — ne pas modifier à la main.\nconst SITE_DATA = ${JSON.stringify(payload)};\n`,
  "utf8"
);
console.log(`Synchronisation terminée : ${records.length} pages exportées.`);
