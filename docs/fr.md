# Legrand In One CPL

Intégration non officielle, sans lien avec Legrand. Elle permet d'allumer et d'éteindre depuis Gladys les éclairages d'une installation Legrand In One (courants porteurs, « CPL ») et d'afficher leur état quand quelqu'un appuie sur un interrupteur mural.

## Ce qu'il vous faut

- Une interface Legrand USB / RS232, référence 882 13, branchée sur la machine qui fait tourner Gladys.
- Un petit conteneur « passerelle série » qui expose ce périphérique USB sur un port TCP. Les intégrations Gladys ne peuvent pas accéder directement aux périphériques USB : ce conteneur le fait à leur place (voir le README du projet pour un `docker-compose.yml` prêt à l'emploi).

## Installation

1. Démarrez le conteneur de la passerelle série. Par défaut, il écoute sur `172.17.0.1:2000`.
2. Installez cette intégration et vérifiez l'adresse et le port dans ses paramètres.
3. **Appuyez une fois sur chaque interrupteur.** Le bus Legrand ne sait pas lister ses équipements : l'intégration apprend chaque circuit à partir des trames que les interrupteurs envoient quand on appuie dessus.
4. Ouvrez l'onglet Découverte et lancez une recherche. Chaque circuit vu sur le bus apparaît comme une lumière nommée `Legrand <id>-<unité>`, suivie entre parenthèses du produit probable, par exemple `(inter double 672 02/04 ?)`. Ce libellé est déduit des touches déjà entendues : il s'affine quand vous appuyez sur les autres touches du même appareil, et le point d'interrogation rappelle que c'est une estimation. Créez les circuits que vous voulez et renommez-les.

Si un interrupteur n'apparaît pas, appuyez dessus de nouveau et relancez la recherche. La liste des circuits connus est conservée après un redémarrage.

## Ce que fait l'intégration

- Allume et éteint les lumières depuis Gladys (tableau de bord, scènes, voix).
- Met à jour l'état dans Gladys quand un interrupteur mural est utilisé.
- Affiche chaque bouton de scénario Legrand comme un bouton dans Gladys (`Legrand scenario <id>-<unité>`). Il « clique » quand le scénario est lancé : vous pouvez l'utiliser comme déclencheur dans les scènes Gladys.

## Appareils liés

Le bus ne dit jamais l'état d'un récepteur. Quand un bouton pilote plusieurs lumières (un groupe, une scène), seul le bouton envoie une trame et les lumières restent muettes. Les réglages **Règle 1** à **Règle 12** (une règle par champ) indiquent à l'intégration quelles lumières suivent quel bouton. Rien n'est envoyé sur le bus : seul l'état affiché dans Gladys est mis à jour.

Utilisez les numéros de circuit affichés dans les journaux (`944559-1`). Une règle par champ. S'il vous faut plus de 12 règles, mettez-en plusieurs dans un même champ, séparées par `;` :

```
648966-1 -> 944559-1, 944559-2
648966-2 -> 944559-1=on, 944559-2=off
```

Plusieurs règles dans un seul champ : `929520-1 -> 944561-1; 929523-1 -> 944561-1`.

- Avec une lumière à gauche, les lumières de droite copient son état (allumée, éteinte), qu'il vienne d'un interrupteur mural ou d'une commande dans Gladys.
- Avec un bouton de scène à gauche, chaque lumière de droite prend l'état fixe écrit après `=` (`on` ou `off`).

## Matériel testé

Cette intégration a été mise au point sur une seule installation, avec :

- l'interface Legrand CPL/USB **réf. 882 13** (vue par Linux comme un périphérique série USB BTicino « SFERA Tele Loop ») ;
- des interrupteurs doubles émetteurs-récepteurs **réf. 672 02** (deux directions : touche du haut = allumer, touche du bas = éteindre) ;
- un interscénario d'éclairage **réf. 672 08** (touches marche/arrêt + deux touches de scénario) ;
- un interscénario émetteur **réf. 672 80** (quatre touches de scénario) ;
- Gladys Assistant 5.3 sur un Home Assistant Yellow (ARM 64 bits).

## Comment lire les appareils dans Gladys

Dans le système In One, chaque produit a un identifiant unique et chaque récepteur *apprend* les émetteurs qui le commandent (touche LEARN). Sur le bus ne circulent que des ordres d'**émetteurs** : « la direction 1 de l'émetteur 944559 dit *allumer* ». Les récepteurs qui ont appris cet émetteur réagissent, sans rien dire.

Un appareil `Legrand 944559-1` dans Gladys est donc **une touche d'émetteur** (identifiant 944559, direction 1), pas une lampe. Le commander depuis Gladys revient à appuyer sur cette touche : tous les récepteurs qui l'ont apprise réagissent. C'est pourquoi un émetteur appris par plusieurs récepteurs allume plusieurs lampes, et pourquoi l'état d'un récepteur ne peut jamais être lu : il n'existe pas sur le bus. Le réglage **Appareils liés** sert à décrire ces associations pour que Gladys affiche le bon état.

## Références de la gamme In One CPL

D'après le guide technique Céliane. Seules les trois références ci-dessus ont été testées ; pour les autres, la colonne « Attendu » dit ce que le protocole laisse prévoir, **sans vérification**.

**Éclairage**

| Référence | Produit | Attendu |
|---|---|---|
| 672 01 | Inter simple émetteur-récepteur 2 500 W | Comme le 672 02 : devrait fonctionner |
| 672 02 | Inter double émetteur-récepteur 2 × 1 000 W | **Testé** |
| 672 03 / 672 04 | Inter simple / double à voyant | Comme 672 01 / 672 02 : devrait fonctionner (le voyant est local, il ne remonte pas sur le bus) |
| 672 08 | Interscénario d'éclairage (marche/arrêt + 2 scénarios) | **Testé** |
| 672 15 | Inter automatique 1 000 W (détecteur) | Devrait émettre des ordres marche/arrêt comme un inter |
| 672 10 / 672 12 / 672 14, 036 10 | Variateurs 300 W, 600 W et télévariateur 1 000 W | Marche/arrêt seulement ; pas de réglage du niveau dans cette version |
| 882 03 | Prisinter variateur mobile 500 W | Marche/arrêt seulement |
| 882 00, 882 01, 882 15, 882 20 | Télécommandes et interscénarios infrarouge/radio | Non : ils ne passent pas par le bus CPL, sauf via un récepteur CPL/IR qui relaie |

**Scénarios**

| Référence | Produit | Attendu |
|---|---|---|
| 672 80 | Interscénario émetteur (4 scénarios) | **Testé** |
| 672 84 | Gestionnaire de scénarios à écran tactile | Ses scénarios devraient apparaître comme des boutons ; non vérifié |

**Volets et stores**

| Référence | Produit | Attendu |
|---|---|---|
| 672 51 / 672 55 / 672 56 | Inter individuel de volet (simple, avec dérogation, à niveau programmable) | Non pris en charge dans cette version (ordres montée/descente/arrêt, famille différente du protocole) |
| 672 53 / 672 54 | Commande centralisée / commande de groupe (4 zones) | Non pris en charge dans cette version |

**Chauffage, détecteurs, interfaces** : thermostats 674 40 / 674 42, sortie de câble 674 45, dérogation 674 48, programmateur 674 49, détecteurs 675 22 / 675 23 / 675 24, interfaces 036 06 / 036 07 / 036 18 — hors du périmètre de cette intégration. Les filtres 882 12 / 882 21 / 882 23 sont des accessoires passifs.

Si vous testez l'une de ces références, dites-le sur le dépôt GitHub du projet : le tableau sera mis à jour.

## Limites de cette version

- Le bus ne signale jamais l'état réel d'un récepteur. L'état affiché dans Gladys est déduit des trames et des commandes envoyées : il peut se décaler (par exemple après un scénario Legrand qui éteint des lampes). Une commande depuis Gladys le remet toujours d'accord.
- Pour tenir Gladys à jour après un scénario Legrand, utilisez les appareils liés (règle `scénario -> lampe=on`).
- Lumières tout ou rien uniquement : pas de variateurs, pas de volets, et Gladys ne peut pas lancer un scénario Legrand.
