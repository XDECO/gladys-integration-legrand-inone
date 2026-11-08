# Legrand In One CPL

Intégration non officielle, sans lien avec Legrand. Elle permet d'allumer et d'éteindre depuis Gladys les éclairages d'une installation Legrand In One (courants porteurs, « CPL ») et d'afficher leur état quand quelqu'un appuie sur un interrupteur mural.

## Ce qu'il vous faut

- Une interface Legrand USB / RS232, référence 882 13, branchée sur la machine qui fait tourner Gladys.
- Un petit conteneur « passerelle série » qui expose ce périphérique USB sur un port TCP. Les intégrations Gladys ne peuvent pas accéder directement aux périphériques USB : ce conteneur le fait à leur place (voir le README du projet pour un `docker-compose.yml` prêt à l'emploi).

## Installation

1. Démarrez le conteneur de la passerelle série. Par défaut, il écoute sur `172.17.0.1:2000`.
2. Installez cette intégration et vérifiez l'adresse et le port dans ses paramètres.
3. **Appuyez une fois sur chaque interrupteur.** Le bus Legrand ne sait pas lister ses équipements : l'intégration apprend chaque circuit à partir des trames que les interrupteurs envoient quand on appuie dessus.
4. Ouvrez l'onglet Découverte et lancez une recherche. Chaque circuit vu sur le bus apparaît comme une lumière nommée `Legrand <id>-<unité>`. Créez ceux que vous voulez et renommez-les.

Si un interrupteur n'apparaît pas, appuyez dessus de nouveau et relancez la recherche. La liste des circuits connus est conservée après un redémarrage.

## Ce que fait l'intégration

- Allume et éteint les lumières depuis Gladys (tableau de bord, scènes, voix).
- Met à jour l'état dans Gladys quand un interrupteur mural est utilisé.

## Limites de cette version

- Lumières tout ou rien uniquement : pas de variateurs, pas de volets, pas de scénarios Legrand.
- Le bus n'accuse pas réception des commandes. Après une commande, Gladys affiche l'état demandé ; le prochain appui sur un interrupteur mural le corrige si la lumière n'a pas suivi.
