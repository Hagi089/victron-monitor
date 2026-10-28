/* Läuft vor dem ersten Zeichnen, damit die Seite nicht im falschen Modus aufblitzt */
try { var th = localStorage.getItem('victron-theme'); if (th === 'light' || th === 'dark') { document.documentElement.setAttribute('data-theme', th); } } catch (e) { /* egal */ }
