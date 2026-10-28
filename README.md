# Obelix Strom Dashboard

Bluetooth-Anzeigemonitor für Victron-Geräte (Instant Readout) und den LANGZEIT-Akku, gedacht für Bluefy auf dem iPad.

Dateien: `index.html` (Aufbau), `app.js` (Logik), `style.css` (Aussehen), `theme.js` (Hell/Dunkel vor dem ersten Zeichnen).

## Sicherheit

- Schlüssel bleiben nur im Browser des iPads (localStorage). Niemals Schlüssel in dieses Repo schreiben, es ist öffentlich.
- Content-Security-Policy: nur eigene Skripte und Stile, keine Netzwerkverbindungen, keine fremden Inhalte.
  Deshalb keine Inline-Skripte, keine `style="…"`-Attribute und keine externen Bibliotheken einbauen.
- Der Akku erhält ausschließlich die zwei festen Lese-Anfragen (`isAllowedBmsRequest` in `app.js`), Schreibbefehle sind blockiert.
- Gerätenamen kommen per Funk und gelten als fremde Eingabe: Ausgabe nur über `textContent`, nie über `innerHTML`.
- Die Seite startet nicht, wenn sie in eine fremde Seite eingebettet wird.
