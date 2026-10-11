# Markdown Live Editor

Bearbeite Markdown-Dateien direkt in der gerenderten Ansicht (ähnlich Obsidian/Typora), in einem einzigen Tab.

## Benutzung

- **Live-Editor öffnen:** In einer `.md`-Datei oben rechts auf das Stift-Symbol klicken (oder Command Palette → „Markdown Live: Open in Live Editor").
- **Zurück zum Raw-Markdown:** Code-Symbol `</>` oben rechts.
- **Bilder:** Screenshot/Bild mit `Cmd+V` einfügen oder per Drag & Drop (aus dem Finder mit gedrückter `Shift`-Taste) hineinziehen. Das Bild wird im Ordner `<notiz>.assets/` neben der Notiz gespeichert und relativ verlinkt. Beim Schließen der Notiz kommen nicht mehr verlinkte Bilder in den Papierkorb. Wird die Notiz in VS Code umbenannt, verschoben, kopiert oder gelöscht, zieht der Ordner mit bzw. wird mitkopiert (im Finder Notiz und Ordner zusammen verschieben). Ausblenden im Explorer: `"files.exclude": { "**/*.assets": { "when": "$(basename).md" } }`.
- **Bildgröße ändern:** Mit der Maus über ein Bild fahren und an einer der vier Ecken ziehen (wie in OneNote); die Breite wird live in Pixeln angezeigt. Skalierte Bilder werden als `<img src="…" width="…">` gespeichert, das verstehen auch die VS-Code-Vorschau, GitHub und Obsidian.
- **Handschrift:** `Alt+D`, Stift-Symbol oben rechts oder `/` → „Handwriting“ öffnet eine Zeichenfläche (z. B. mit dem iPad als Sidecar-Display und Apple Pencil). Die Fläche (Karopapier) ist unendlich groß: verschieben am Mac mit Trackpad/Mausrad, am iPad mit einem Finger; zoomen mit zwei Fingern (iPad, Trackpad) bzw. `Ctrl`+Mausrad. Zoomen ändert nur die Ansicht, nicht die gespeicherte Größe. Beim Speichern wird eng um das Gezeichnete zugeschnitten, nur das landet in der Notiz. Leiste wie in OneNote: Undo/Redo, Lasso (Striche umkreisen, dann in der Auswahl ziehen zum Verschieben), Platz einfügen/entfernen (aufsetzen und nach oben/unten ziehen: alles darunter wandert mit), Radierer (nochmal antippen: Strichradierer löscht ganze Striche, Punktradierer nur das Überstrichene), 4 Stifte und 3 Textmarker (liegen unter der Schrift; den gewählten nochmal antippen: Farbe aus der Palette oder über den Regenbogen-Kreis frei wählen – Farben werden gemerkt), Formen wie in OneNote (Linie, Pfeil, Doppelpfeil, Rechteck, Ellipse, Kreis, Dreiecke, Raute, Parallelogramm, Trapez, Koordinatensysteme; aufziehen von Ecke zu Ecke, in aktueller Stiftfarbe/-stärke) und 5 Dicken-Stufen von fein bis sehr fett direkt neben den Stiften (Standard: dünn); die Dicke gilt für alle Stifte bzw. alle Textmarker. „Done“ speichert, „Cancel“ verwirft. Gespeichert wird als `<notiz>.assets/<zeit>.drawing.svg`, mit den Strichdaten in der SVG eingebettet: Die Zeichnung wird überall wie ein normales Bild angezeigt und lässt sich im Live-Editor per **Doppelklick** weiterbearbeiten. Die Tinte ist dunkel gespeichert und wird in dunklen Themes invertiert angezeigt (andere Programme zeigen sie im Dark Mode dunkel an).
- **Handschrift auf dem iPad:** Einstellung `mdLive.drawingDevice` auf `ipad` stellen (oder Command Palette → „Markdown Live: Draw on iPad: Show Address“, das stellt es gleich um). Die Adresse aus diesem Befehl in Safari auf dem iPad öffnen (wird in die Zwischenablage kopiert, per Universal Clipboard auf dem iPad einfügen) und am besten über „Teilen → Zum Home-Bildschirm“ ablegen. Die Seite wartet dann; `Alt+D` oder Doppelklick auf eine Zeichnung am Mac öffnet die Zeichenfläche auf dem iPad, „Done“ fügt die Zeichnung in die Notiz ein. Am Mac zeigt eine Meldung, dass gezeichnet wird (dort auch „Cancel“). Mac und iPad müssen sich im Netzwerk erreichen können (gleiches WLAN, oder z. B. Tailscale). Nur der Pencil zeichnet, ein Finger verschiebt die Fläche, zwei Finger zoomen. Beim ersten Start fragt die macOS-Firewall evtl., ob VS Code eingehende Verbindungen annehmen darf → erlauben. Die Adresse enthält einen geheimen Schlüssel, der gleich bleibt (Port: `mdLive.ipadPort`, Standard 8765).
- **Stichpunkte verschieben:** `Alt+↑` / `Alt+↓` verschiebt nur die Zeile des Stichpunkts unter dem Cursor (bzw. der markierten) um eine Zeile, mit gleicher Einrückung – wie Zeilen im Raw-Markdown oder in OneNote. Unterpunkte bleiben stehen und gehören danach zum Punkt, der über ihnen steht. Außerhalb von Listen werden ganze Absätze, Überschriften oder Bilder verschoben. Einrücken: `Tab` / `Shift+Tab` – ebenfalls nur die Zeile selbst, Unterpunkte behalten ihre Ebene.
- **Markierung an Claude:** Text markieren und `Alt+K` drücken (oder Funken-Symbol oben rechts). Die Datei wird kurz als Texteditor geöffnet, die passenden Zeilen markiert und als `@datei.md#Lx-y` an Claude Code übergeben.

## Tastenkürzel

Gelten nur, wenn der Live-Editor den Fokus hat. `Alt` ist auf dem Mac die `Option`-Taste. Die Formatierungs-Kürzel schalten um: nochmal drücken entfernt die Formatierung wieder.

In Stichpunktlisten wirken alle Kürzel außer `Alt+M` auf den ganzen Stichpunkt, in dem der Cursor steht – auch ohne oder mit nur teilweiser Markierung. Ausnahme Hervorheben (`Alt+Q/W/E/R/H`): ohne Markierung der ganze Stichpunkt, mit Markierung nur der markierte Text. Außerhalb von Listen gilt nur der markierte Text.

| Shortcut | Funktion | Im Markdown |
|---|---|---|
| `Alt+B` | Fett | `**Text**` |
| `Alt+I` | Kursiv | `*Text*` |
| `Alt+S` | Durchgestrichen | `~~Text~~` |
| `Alt+W` (oder `Alt+H`) | Hervorheben gelb | `==Text==` |
| `Alt+Q` / `Alt+E` / `Alt+R` | Hervorheben rot / grün / blau (nochmal gleiche Farbe = entfernen, andere Farbe = umfärben) | `<mark style="background: #FF5582A6;">Text</mark>` |
| `Alt+C` | Code (ersetzt andere Formatierungen) | `` `Text` `` |
| `Alt+M` | Formel (auch: Formel anklicken → zurück zu Text) | `$Text$` |
| `Alt+1` … `Alt+6` | Überschrift Ebene 1–6 (gleiche Ebene nochmal = normaler Text) | `# Text` … `###### Text` |
| `Alt+^` | Überschrift aufheben (normaler Text) | – |
| `Alt+K` | Markierung an Claude Code übergeben | – |
| `Alt+D` | Handschrift/Zeichnung einfügen | Bildlink auf `notiz.assets/….drawing.svg` |
| `Alt+↑` / `Alt+↓` | Stichpunkt bzw. Absatz nach oben/unten verschieben | – |
| `Tab` / `Shift+Tab` | Stichpunkt ein-/ausrücken | – |
| `Tab` / `Shift+Tab` in Überschrift | Überschrift eine Ebene tiefer/höher (H2 → H3 / H3 → H2) | – |

## Bekannte Einschränkungen

- **Kopieren zwischen verschiedenen Workspaces/VS-Code-Fenstern:** Beim Kopieren einer Notiz sucht die Extension die verlinkten Bilder nur im aktuell geöffneten Workspace und kopiert sie in den `.assets`-Ordner der Kopie. Liegt das Original in einem anderen Workspace (z. B. Kopieren aus einem anderen Repo bzw. VS-Code-Fenster), werden die Bilder nicht gefunden und die Links in der Kopie sind kaputt. Abhilfe: den `.assets`-Ordner im Finder mitkopieren, oder beide Ordner in einem Multi-Root-Workspace öffnen (dann werden alle Ordner durchsucht).
- **Dateioperationen außerhalb von VS Code** (Finder, Terminal, git) bekommt die Extension nicht mit: Notiz und `<notiz>.assets/` müssen dort zusammen verschoben bzw. kopiert werden.

## Entwicklung

```bash
npm install
npm run build      # oder: npm run watch
```

`F5` startet eine Extension-Development-Instanz mit dem Ordner `notes/`.
