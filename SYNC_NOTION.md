# Synchronisation Notion → GitHub → site

Le site est désormais préparé pour publier le dossier **DOCUMENTATION POLITIQUE — Base de Décision d'État** depuis Notion, sans réécriture manuelle de `data.js`.

## Source

- Page racine Notion : `35362af8-e03f-81d1-9371-e30c4a7e7c33`
- Hiérarchie attendue : **Thème → Sous-thème / Catégorie → Fiche**
- Export : `scripts/sync-notion.mjs`
- Données publiées : `data.js`
- Workflow : `.github/workflows/sync-notion.yml`

## Mise en route

Dans les secrets GitHub du dépôt, créer :

- `NOTION_TOKEN` : token d'une intégration Notion ayant accès à toute la page racine et à ses descendants.
- `NOTION_ROOT_ID` : `35362af8-e03f-81d1-9371-e30c4a7e7c33`

Le workflow peut ensuite être lancé manuellement ou s'exécute quotidiennement.

## Ce que fait l'export

- parcourt récursivement les pages enfants ;
- récupère le contenu des blocs ;
- transforme le contenu Notion en HTML statique ;
- conserve les URL Notion et les dates de modification ;
- reconstruit les thèmes, catégories et fiches pour le moteur actuel du site ;
- génère la recherche plein texte côté navigateur ;
- commit automatiquement `data.js` uniquement lorsqu'il a changé.

## Sécurité

Le site nettoie le HTML des fiches avant insertion dans le DOM. Les scripts et attributs événementiels ne sont pas exécutés.

## État de l'import

Le dépôt contient encore le jeu de données statique historique tant qu'un `NOTION_TOKEN` disposant de l'accès complet n'a pas été fourni au workflow. Une fois les deux secrets configurés, le premier run remplace `data.js` par l'export intégral de l'arborescence accessible.
