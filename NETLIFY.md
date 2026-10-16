# Kniffel auf Netlify veröffentlichen

Das Spiel ist eine statische Seite; die Mehrspieler-API läuft als Netlify Function. Räume und Spielstände werden in Netlify Blobs gespeichert.

## Veröffentlichung

1. Lege den Projektordner in ein GitHub-, GitLab- oder Bitbucket-Repository.
2. Wähle in Netlify **Add new site → Import an existing project** und verbinde das Repository.
3. Lasse Build command und Publish directory von `netlify.toml` übernehmen.
4. Veröffentliche die Seite. Netlify installiert `@netlify/blobs` und bündelt die Function automatisch.

Die Seite ist anschließend über die von Netlify angezeigte URL erreichbar. Beim Erstellen eines Raums wählt der Gastgeber 2 bis 4 Spieler. Nach Belegung aller Plätze startet die Partie automatisch. Der Gastgeber teilt den sechsstelligen Code oder den Einladungslink; zum Beitreten reicht der Code. Verlässt ein Spieler den Raum über die Schaltfläche, wird er für alle geschlossen. Eine unterbrochene Partie kann mit demselben Browser bis zu 15 Minuten später fortgesetzt werden.

## Lokale Vorschau

Mit Node.js installiert, im Projektordner ausführen:

```sh
npm install
npx netlify dev
```

Die Netlify CLI stellt dabei auch die Function-Endpunkte bereit. Der Build kopiert die Seite und benötigte Medien nach `dist`; Netlify veröffentlicht diesen Ordner und bündelt die Functions separat. `index.html` direkt als Datei zu öffnen reicht für Mehrspieler nicht, da dann kein API-Server existiert.

## Daten und Grenzen

Räume und Spielstände bleiben in Netlify Blobs gespeichert, auch wenn die Function beendet wird. Persönliche Erfolge und Partiestatistiken werden lokal im Browser gespeichert. Blobs bietet keine Transaktionssperren für gleichzeitige Schreibzugriffe; für sehr viele gleichzeitig schreibende Spieler wäre später eine Datenbank mit Transaktionen sinnvoll.
