# Design system Meridian

Source : `apps/portal/public/site.css` (bloc « Design system Meridian »).

## Couleurs
- Espace colorimétrique **OKLCH** : même luminosité perçue d'une teinte à l'autre.
- Échelles à **12 niveaux** (modèle Radix) : `--gray-1…12`, `--blue-1…12`, plus états `green`, `amber`, `red` (niveaux 3 et 11).
  - 1–2 fonds · 3–5 surfaces et survol · 6–8 bordures · 9–10 accent plein · 11–12 texte.
- Les composants n'utilisent que des **jetons sémantiques** : `--bg`, `--surface`, `--ink`, `--ink2`, `--mute`, `--hair`, `--accent`, `--accent-ink`, `--accent-soft`, `--ok`, `--run`, `--no` (+ `-soft`).
- Règle de sens : bleu = marque et action ; vert = payé ; ambre = en cours ; rouge = refus uniquement.

## Typographie
- Instrument Sans (texte, titres 500), IBM Plex Mono (montants, heures, empreintes, code). Auto-hébergées, OFL.
- Titres serrés (`letter-spacing:-.04em`), `text-wrap: balance`.

## Espacement, rayons, ombres, mouvement
- Pas de 4 : `--s1` (4) → `--s8` (64). Rayons `--r` 20, `--r-s` 12. Ombres `--shadow`, `--shadow-l`.
- Courbe `--ease`. Apparition au défilement en CSS natif (`animation-timeline: view()`), transitions de vue natives, tout désactivé sous `prefers-reduced-motion`.

## Écriture
- Un titre = un problème ou un résultat pour le lecteur, jamais un slogan.
- Chaque affirmation renvoie à une preuve visible (démo, test, journal). Aucun chiffre non mesuré.
