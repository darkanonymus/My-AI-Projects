# Q&R contextuelle dans une leçon — design

Date : 2026-06-08
Statut : validé par l'utilisateur (en attente de relecture finale du document écrit)
Périmètre : `web/learn.jsx`, `web/lib/render.jsx`, `web/lib/prompts.jsx`, `web/main.jsx`

## 1. Problème et objectif

En lisant une leçon générée, l'utilisateur tombe parfois sur un passage qu'il ne
comprend pas (terme, formule, étape de raisonnement, exemple trop abstrait).
Aujourd'hui, il n'a aucun moyen de poser une question ciblée sur CE passage
précis, ni de demander un exemple plus concret, ni de signaler "ce point mérite
une carte de révision" — sans quitter la leçon ou réécrire un nouveau cours.

Objectif : permettre à l'utilisateur de sélectionner un passage du cours
généré et, à cet endroit précis, (a) poser une question, (b) demander un
exemple plus simple/concret, ou (c) demander que ce passage soit considéré pour
le quiz/les flashcards — avec dédoublonnage automatique. Le résultat (question
+ réponse, exemple) est proposé à l'insertion avec un choix explicite
"Insérer ici" / "Ignorer", et tout bloc inséré reste supprimable à tout moment.

## 2. Contraintes héritées (à respecter impérativement)

- **Ne rien casser** : l'app fonctionne déjà ; toute modification doit être
  vérifiée en conditions réelles (Playwright, zéro erreur console) avant
  d'être considérée terminée.
- **Pas de bundler** : `index.html` charge des `<script type="text/babel">`
  en chaîne ; toute communication entre fichiers passe par
  `Object.assign(window, {...})`. Tout nouveau fichier doit suivre cette
  convention et être ajouté dans `index.html` au bon endroit de la chaîne de
  chargement.
- **Organisation par "concern"** : pas de fichier fourre-tout — chaque nouveau
  bloc de logique va dans un fichier nommé selon son rôle, à l'image du
  découpage déjà fait de `lib.jsx` en 8 fichiers (`lib/prompts.jsx`,
  `lib/render.jsx`, etc.).

## 3. Modèle de données

Le texte du cours (`chapter.sections[n].contenu`, une chaîne markdown) **n'est
jamais modifié**. On ajoute un nouveau tableau au niveau du chapitre :

```js
chapter.insertions = [
  {
    id: "ins7",                  // identifiant unique : même schéma que newId()/CH_SEQ
                                 // (compteur local relancé au chargement en relisant
                                 // le plus grand id existant, voir loadState)
    sectionN: 3,                 // quelle section du cours
    afterBlock: 2,               // index du bloc de contenu après lequel afficher la fiche
    anchorQuote: "la dérivée représente...", // texte sélectionné par l'utilisateur (affiché en rappel)
    kind: "question" | "example" | "addToBank",
    question: "pourquoi c'est une pente ?",  // saisie utilisateur (vide pour "example"/"addToBank")
    answer: "...",               // texte markdown renvoyé par Lia (vide pour "addToBank" pur)
    sourceLabel: "cours" | "hors-cours", // d'où vient la réponse (voir §5)
    addedToCards: false,         // déjà ajouté en flashcard ?
    addedToQuiz: false,          // déjà ajouté en question de quiz ?
    createdAt: 1234567890
  }
]
```

- Persisté exactement comme le reste du chapitre (localStorage `hml_state_v2`
  + `/api/state` côté serveur) — aucun changement requis à la couche de
  persistance, elle sérialise déjà tout `chapters`.
- Suppression = retirer l'entrée du tableau (`filter` par `id`). Le contenu de
  la section n'est jamais touché : risque de corruption nul.

### Pourquoi pas "insérer directement dans le markdown du cours" ?

Cette alternative (façon `[[C]]...[[/C]]`) a été écartée : repérer la position
exacte d'un passage sélectionné dans une chaîne markdown générée par l'IA, puis
le découper proprement à la suppression, est fragile (passages dupliqués,
caractères spéciaux, blocs imbriqués, décalages Unicode) — un risque direct
pour le contenu déjà généré, contraire à la contrainte "ne pas casser ce qui
fonctionne déjà". Le tableau séparé donne le même résultat visuel ("la fiche
apparaît juste après le bon paragraphe") sans toucher au texte source.

## 4. Repérage du bloc sélectionné (ancrage)

`renderBlocks()` (dans `lib/render.jsx`) produit déjà un tableau ordonné de
nœuds React (un par paragraphe / liste / titre / figure). On ajoute un attribut
`data-block-index={k}` sur chaque nœud racine de bloc — un changement additif,
sans impact sur le rendu visuel ni sur les exports.

Quand l'utilisateur termine une sélection dans un `<div className="prose">`,
on lit `window.getSelection()`, on prend le texte sélectionné, et on remonte le
DOM depuis le nœud de départ de la sélection jusqu'au premier ancêtre portant
`data-block-index` — cela donne `afterBlock`. La sélection est attendue courte
et contenue dans un seul bloc/paragraphe (confirmé avec l'utilisateur : c'est
le cas d'usage normal — on encercle ce qu'on ne comprend pas, rarement un pavé
de plusieurs paragraphes). Si la sélection déborde sur plusieurs blocs, on
retient le bloc de DÉPART (comportement simple et prévisible).

## 5. Le menu d'actions (barre flottante)

Dès qu'une sélection non vide existe à l'intérieur d'une zone `.prose` (cours
ET exercices — confirmé : c'est là qu'on bloque le plus), une petite barre
flottante apparaît au-dessus de la sélection (`position: absolute`, calculée
depuis `getBoundingClientRect()` du `Range`), avec 3 actions :

### ① 💬 Poser une question
Un champ de texte libre s'ouvre ; l'utilisateur tape sa question précise.
Lia reçoit alors : le passage sélectionné + la question + (voir §6) le
contexte de mise à la terre. Réponse affichée avec une étiquette de provenance
(`sourceLabel`) : *"📖 D'après le cours"* si trouvée dans le cours/le contenu
source fourni, *"Hors cours — explication complémentaire"* sinon.

### ② 💡 Demander un exemple
Un clic suffit (pas de saisie obligatoire). Lia regarde le passage et son
contexte immédiat dans la section : si un exemple existe déjà à proximité,
elle en propose un *plus concret/plus simple* sur le même concept ; sinon elle
en construit un nouveau, adapté au niveau et à la langue du cours.

### ③ 🎴 Ajouter au quiz / flashcards
Fonctionne **directement sur une sélection du cours original** — pas seulement
sur un bloc déjà inséré (point clarifié explicitement par l'utilisateur : le
LLM ne couvre pas toujours tout pendant la génération initiale, l'utilisateur
doit pouvoir combler les trous lui-même). Lia vérifie si le concept est déjà
couvert par `chapter.quiz` ou `chapter.cards` (voir §7) ; si non, elle crée
l'entrée manquante (carte et/ou question) ; si oui, elle l'indique simplement
sans dupliquer.

Pour ① et ②, le résultat est proposé dans une fiche dépliée juste sous le
bloc concerné, avec deux boutons : **"+ Insérer ici"** (persiste l'entrée dans
`chapter.insertions`, voir §3) et **"Ignorer"** (rien n'est sauvegardé, la
fiche disparaît). Pour ③, il n'y a rien à "insérer dans le cours" — l'action
modifie directement `chapter.quiz`/`chapter.cards` (pas le texte de la leçon) —
donc le résultat est annoncé via le mécanisme de toast déjà existant
(`flash(msg)` dans `main.jsx`, utilisé par ex. après le téléchargement d'un
cours) : *"✓ Ajouté : nouvelle flashcard créée"* ou *"ℹ️ Déjà couvert par la
carte « ... »"* — cohérent avec le reste de l'app, aucun nouveau composant de
notification à construire.

## 6. Mise à la terre (grounding) — comment Lia vérifie le cours d'abord

Pas de recherche web (confirmé avec l'utilisateur : `server.py` n'a aucune
intégration de recherche aujourd'hui, et en ajouter une introduirait une
dépendance réseau/clé API/coût qui casserait le fonctionnement hors-ligne avec
Ollama). La "vérification dans le support" se fait en donnant à Lia, dans le
même appel, exactement ce qu'elle a déjà pour générer le cours :

- `sourceBlock(chapter)` — le contenu source fourni par l'étudiant (existe
  déjà dans `lib/prompts.jsx`, réutilisé tel quel) ;
- le texte généré de la section concernée (`section.contenu`) et,
  éventuellement, des sections voisines via `buildPriorContext` — pour que Lia
  puisse dire "c'est expliqué en section 2" plutôt que de répéter ;
- une instruction explicite : *"Réponds D'ABORD en te basant sur ce contenu ;
  si l'information n'y est vraiment pas, réponds avec tes connaissances
  générales, de façon simple et cohérente avec le niveau/la langue du cours, et
  indique-le clairement."*

Lia répond en JSON structuré (`{ "reponse": "...", "trouveDansLeCours": true|false }`),
parsé avec `parseJSON` (déjà existant dans `lib/prompts.jsx`) — ce qui permet
de remplir `sourceLabel` de façon fiable plutôt que de deviner depuis du texte
libre.

Nouveau fichier `lib/grounding.jsx` (respect de la convention "un fichier par
concern") contenant les nouveaux constructeurs de prompts :
`buildAskPrompt(chapter, section, passage, question)`,
`buildExamplePrompt(chapter, section, passage)`,
`buildBankCheckPrompt(chapter, passage)` — sur le modèle exact des builders
existants dans `lib/prompts.jsx` (même style, même `buildLangTail`, même
`callClaude`).

## 7. Vérification anti-doublon (flashcards / quiz)

Avant de créer une nouvelle carte ou question, on transmet à Lia la liste
existante en compact : `chapter.cards.map(c => c.recto)` et
`chapter.quiz.map(q => q.q)` (juste les intitulés, pas les réponses — prompt
court). Lia répond en JSON structuré, en respectant exactement les formes déjà
utilisées par `genCards`/`genQuiz` (pour brancher directement sur le même code
d'application sans transformation) :

```json
{
  "card":  { "déjàCouvert": false, "doublonDe": "", "recto": "...", "verso": "..." },
  "quiz":  { "déjàCouvert": true,  "doublonDe": "Pythagore : énoncé", "q": "", "options": [], "correct": 0, "explication": "" }
}
```

Si `déjàCouvert` est `false`, l'app ajoute l'entrée à `chapter.cards`/
`chapter.quiz` via `patchChapter` (même mécanisme que `genCards`/`genQuiz`
dans `main.jsx`) et marque `addedToCards`/`addedToQuiz` sur l'entrée
d'insertion correspondante si applicable. Si `déjàCouvert` est `true`, rien
n'est ajouté — `doublonDe` sert uniquement au message affiché à l'utilisateur
(voir le toast au §5).

## 8. Affichage des fiches insérées et suppression

Style visuel **distinct** de l'encadré "＋ Complément ajouté (hors cours)"
existant (qui reste réservé aux ajouts faits automatiquement par Lia pendant
la génération) — nouvel encadré "💬 Votre question : « ... »" avec sa propre
couleur d'accent, affichant : la citation du passage, la question (si "ask"),
la réponse, l'étiquette de provenance, la date, et deux boutons toujours
visibles :

- **🎴 Ajouter au quiz/cartes** (si pas déjà fait — invoque le flux du §7) ;
- **🗑 Supprimer** — retire l'entrée de `chapter.insertions` (avec une petite
  confirmation pour éviter les clics accidentels). Si l'entrée avait déjà été
  ajoutée au quiz/flashcards, l'app demande explicitement : *"Supprimer aussi
  la carte/question associée, ou la garder ?"* — pour ne jamais faire perdre
  une carte de révision utile sans confirmation explicite.

`SectionCard` (dans `learn.jsx`) parcourt les blocs rendus de `contenu` et,
après chaque bloc d'index `k`, insère les fiches dont `afterBlock === k` pour
la section courante — sans toucher au rendu du bloc lui-même.

## 9. Gestion des erreurs

Mêmes patterns que le reste de l'app (cohérence — pas de nouveau vocabulaire
d'erreur à apprendre) :
- Serveur local injoignable → message existant *"Le serveur local ne répond
  pas. Lance « python server.py »..."*, avec bouton **Réessayer**.
- Réponse vide ou trop courte (`< 2` caractères, comme `retrySection`) →
  message d'erreur dans la fiche au lieu d'une fiche vide ; rien n'est inséré
  tant que l'utilisateur n'a pas de résultat exploitable.
- Tant que l'utilisateur n'a pas cliqué "Insérer", **rien n'est persisté** —
  fermer la fiche ou re-sélectionner ailleurs l'efface sans laisser de trace.

## 10. Vérification ("ne rien casser")

Même méthode que pour la réorganisation de `lib.jsx` :
1. Test Playwright en conditions réelles : sélectionner du texte → menu
   apparaît → poser une question → réponse affichée avec étiquette → insérer →
   fiche visible au bon endroit → supprimer → fiche disparaît, cours intact ;
   demander un exemple ; ajouter au quiz/cartes (cas "nouveau" ET cas
   "doublon détecté") ; zéro erreur console/page tout du long.
2. Vérifier que les fonctionnalités existantes (génération de cours, quiz,
   flashcards, export HTML, changement de langue/niveau, etc.) fonctionnent
   exactement comme avant — la persistance de `chapters` inclut désormais
   `insertions`, donc on vérifie aussi qu'un ancien chapitre sans ce champ se
   charge sans erreur (`insertions || []` partout en lecture).

## 11. Fichiers impactés (récapitulatif)

| Fichier | Nature du changement |
|---|---|
| `web/lib/render.jsx` | Ajout additif : `data-block-index` sur les blocs (zéro impact visuel) |
| `web/lib/grounding.jsx` *(nouveau)* | Builders de prompts pour question / exemple / vérif anti-doublon |
| `web/lib/prompts.jsx` | Aucun changement (réutilisation de `sourceBlock`, `parseJSON`, `buildLangTail`) |
| `web/learn.jsx` | Nouveau composant "barre de sélection" + rendu des fiches dans `SectionCard` |
| `web/main.jsx` | `freshChapter` initialise `insertions: []` ; nouvelles fonctions `addInsertion`/`deleteInsertion`/`checkAndAddToBank` (mêmes patterns que `patchChapter`/`genQuiz`/`genCards`) |
| `web/index.html` | Une ligne ajoutée pour charger `lib/grounding.jsx` (après `lib/prompts.jsx`, avant `figures.jsx`) |

## 12. Hors-périmètre (explicitement écarté)

- Recherche web réelle (API externe) — refusé par l'utilisateur, casserait le
  fonctionnement hors-ligne et ajouterait coût/dépendance.
- Sélections multi-paragraphes / multi-sections — cas jugé rare par
  l'utilisateur ; non géré spécifiquement (on retient le bloc de départ).
- Réutiliser le style visuel `[[C]]` existant pour les fiches insérées —
  écarté au profit d'un style distinct, pour bien séparer "ajouté par Lia
  pendant la génération" de "demandé personnellement par l'utilisateur".
