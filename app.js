// ===== Données =====
const themes = SITE_DATA.themes;

const themesContainer = document.getElementById("themes");
const detailView = document.getElementById("detail-view");
const appMain = document.getElementById("app");

// ===== Sécurité HTML =====

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ===== Thèmes =====

function renderThemes(list = themes) {
  themesContainer.innerHTML = list.map(theme => {
    const number = String(theme.num).padStart(2, "0");

    return `
      <article class="theme-card" onclick="openTheme(${theme.num})">
        <span class="theme-number">${number}</span>
        <h3>${escapeHtml(theme.titre)}</h3>
      </article>
    `;
  }).join("");
}

function openTheme(num) {
  window.location.hash = `theme/${num}`;
}

function openFiche(id) {
  window.location.hash = `fiche/${encodeURIComponent(id)}`;
}

// ===== Recherche =====

function searchSite() {
  const input = document.getElementById("home-search");
  const value = input.value.trim();

  if (!value) {
    document.getElementById("recherche")
      .scrollIntoView({ behavior: "smooth" });
    return;
  }

  document.getElementById("search-input").value = value;
  runSearch();

  document.getElementById("recherche")
    .scrollIntoView({ behavior: "smooth" });
}

function runSearch() {
  const input = document.getElementById("search-input");
  const results = document.getElementById("search-results");

  const query = input.value.trim().toLowerCase();

  if (!query) {
    results.innerHTML = `
      <p class="search-result">
        Saisissez un terme pour lancer une recherche.
      </p>
    `;
    return;
  }

  const themeMatches = SITE_DATA.themes.filter(t =>
    t.titre.toLowerCase().includes(query)
  );

  const categoryMatches = [];

  SITE_DATA.themes.forEach(t => {
    (t.categories || []).forEach(c => {
      if (c.nom.toLowerCase().includes(query)) {
        categoryMatches.push({
          themeNum: t.num,
          themeTitre: t.titre,
          code: c.code,
          nom: c.nom
        });
      }
    });
  });

  const ficheMatches = (SITE_DATA.fiches || []).filter(f =>
    f.titre.toLowerCase().includes(query)
  );

  if (
    !themeMatches.length &&
    !categoryMatches.length &&
    !ficheMatches.length
  ) {
    results.innerHTML = `
      <p class="search-result">
        Aucun résultat pour
        <strong>${escapeHtml(input.value)}</strong>.
      </p>
    `;
    return;
  }

  let html = "";

  // Thèmes
  themeMatches.forEach(t => {
    const number = String(t.num).padStart(2, "0");

    html += `
      <a
        class="search-result"
        href="#theme/${t.num}"
        onclick="openTheme(${t.num})"
      >
        <span class="search-result-number">
          THÈME ${number}
        </span>
        <h3>${escapeHtml(t.titre)}</h3>
        <p>
          Ouvrir la rubrique documentaire.
        </p>
      </a>
    `;
  });

  // Catégories
  categoryMatches.slice(0, 20).forEach(c => {
    html += `
      <a
        class="search-result"
        href="#theme/${c.themeNum}"
        onclick="openTheme(${c.themeNum})"
      >
        <span class="search-result-number">
          CATÉGORIE ${escapeHtml(c.code)}
        </span>
        <h3>${escapeHtml(c.nom)}</h3>
        <p>
          Dans : ${escapeHtml(c.themeTitre)}
        </p>
      </a>
    `;
  });

  // Fiches
  ficheMatches.slice(0, 20).forEach(f => {
    html += `
      <a
        class="search-result"
        href="#fiche/${encodeURIComponent(f.id)}"
        onclick="openFiche('${escapeHtml(f.id)}')"
      >
        <span class="search-result-number">
          FICHE · ${escapeHtml(f.cat || "")}
        </span>
        <h3>${escapeHtml(f.titre)}</h3>
        <p>
          Texte intégral disponible.
        </p>
      </a>
    `;
  });

  results.innerHTML = html;
}

// ===== Menu mobile =====

function toggleMenu() {
  const nav = document.querySelector(".nav");

  if (nav) {
    nav.classList.toggle("open");
  }
}

// ===== Raccourcis clavier =====

document.addEventListener("keydown", event => {
  if (
    event.key === "Enter" &&
    document.activeElement?.id === "home-search"
  ) {
    searchSite();
  }

  if (
    event.key === "Enter" &&
    document.activeElement?.id === "search-input"
  ) {
    runSearch();
  }
});

// ===== Vue détail : thème =====

function renderThemeDetail(num) {
  const t = SITE_DATA.themes.find(theme => theme.num === num);

  if (!t) {
    return `
      <p>
        Thème introuvable.
      </p>
    `;
  }

  const number = String(t.num).padStart(2, "0");

  let html = `
    <div class="detail-breadcrumb">
      <a
        href="#explorer"
        onclick="closeDetail(event)"
      >
        ← Retour à la carte politique
      </a>
    </div>

    <div class="detail-head">
      <span class="eyebrow">
        THÈME ${number} · BASE FACTUELLE
      </span>

      <h1 class="detail-title">
        ${escapeHtml(t.titre)}
      </h1>

      <p class="detail-meta">
        ≈${t.fiches || 0} fiches actives
        ${
          t.notionId
            ? `
              ·
              <a
                href="https://app.notion.com/p/${t.notionId}"
                target="_blank"
                rel="noopener"
              >
                ouvrir dans Notion →
              </a>
            `
            : ""
        }
      </p>

      <p class="detail-status">
        ${escapeHtml(t.statut || "")}
      </p>
    </div>

    <div class="detail-categories">
  `;

  (t.categories || []).forEach(c => {
    let fichesHere = [];

    Object.keys(SITE_DATA.ficheIndex || {}).forEach(key => {
      if (
        key === c.code ||
        key.startsWith(c.code + ".")
      ) {
        fichesHere = fichesHere.concat(
          SITE_DATA.ficheIndex[key] || []
        );
      }
    });

    html += `
      <article class="category-row">
        <span class="category-code">
          ${escapeHtml(c.code)}
        </span>

        <div class="category-body">
          <h3>
            ${escapeHtml(c.nom)}
          </h3>
    `;

    if (fichesHere.length) {
      html += `
        <div class="fiche-links">
          ${
            fichesHere.map(f => `
              <a
                class="fiche-link"
                href="#fiche/${encodeURIComponent(f.id)}"
                onclick="openFiche('${escapeHtml(f.id)}')"
              >
                📄 ${escapeHtml(f.titre)}
              </a>
            `).join("")
          }
        </div>
      `;
    } else {
      html += `
        <p class="category-empty">
          Détail fiche par fiche non encore intégré
          à ce site — consulter Notion pour le contenu complet.
        </p>
      `;
    }

    html += `
        </div>
      </article>
    `;
  });

  html += `
    </div>
  `;

  return html;
}

// ===== Vue détail : fiche =====

function renderFicheDetail(id) {
  const decodedId = decodeURIComponent(id);

  const f = (SITE_DATA.fiches || [])
    .find(x => String(x.id) === String(decodedId));

  if (!f) {
    return `
      <p>
        Fiche introuvable.
        <a
          href="#explorer"
          onclick="closeDetail(event)"
        >
          Retour
        </a>
      </p>
    `;
  }

  const theme = SITE_DATA.themes
    .find(t => t.num === f.theme);

  return `
    <div class="detail-breadcrumb">
      <a
        href="#theme/${f.theme}"
        onclick="openTheme(${f.theme})"
      >
        ← Retour au thème
        ${theme ? escapeHtml(theme.titre) : f.theme}
      </a>
    </div>

    <div class="detail-head">
      <span class="eyebrow">
        FICHE · ${escapeHtml(f.cat || "")}
      </span>

      <h1 class="detail-title fiche-title">
        ${escapeHtml(f.titre)}
      </h1>
    </div>

    <div class="fiche-body">
      ${f.html || ""}
    </div>
  `;
}

// ===== Retour =====

function closeDetail(event) {
  if (event) {
    event.preventDefault();
  }

  window.location.hash = "explorer";
}

// ===== Routeur =====

function router() {
  const hash = (window.location.hash || "").slice(1);

  if (hash.startsWith("theme/")) {
    const num = parseInt(hash.split("/")[1], 10);

    detailView.innerHTML = renderThemeDetail(num);
    showDetail();

  } else if (hash.startsWith("fiche/")) {
    const id = hash.slice(6);

    detailView.innerHTML = renderFicheDetail(id);
    showDetail();

  } else {
    hideDetail();
  }
}

// ===== Affichage =====

function showDetail() {
  detailView.hidden = false;
  appMain.classList.add("detail-mode");
  window.scrollTo(0, 0);
}

function hideDetail() {
  detailView.hidden = true;
  appMain.classList.remove("detail-mode");
}

// ===== Initialisation =====

window.addEventListener("hashchange", router);

renderThemes();
router();
