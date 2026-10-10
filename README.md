# Markdown Live Editor

Bearbeite Markdown-Dateien direkt in der gerenderten Ansicht (ähnlich Obsidian/Typora), in einem einzigen Tab.

## Benutzung

- **Live-Editor öffnen:** In einer `.md`-Datei oben rechts auf das Stift-Symbol klicken (oder Command Palette → „Markdown Live: Open in Live Editor").
- **Zurück zum Raw-Markdown:** Code-Symbol `</>` oben rechts.
- **Bilder:** Screenshot/Bild mit `Cmd+V` einfügen oder per Drag & Drop (aus dem Finder mit gedrückter `Shift`-Taste) hineinziehen. Das Bild wird im Ordner `<notiz>.assets/` neben der Notiz gespeichert und relativ verlinkt. Beim Schließen der Notiz kommen nicht mehr verlinkte Bilder in den Papierkorb. Wird die Notiz in VS Code umbenannt, verschoben, kopiert oder gelöscht, zieht der Ordner mit bzw. wird mitkopiert (im Finder Notiz und Ordner zusammen verschieben). Ausblenden im Explorer: `"files.exclude": { "**/*.assets": { "when": "$(basename).md" } }`.
- **Bildgröße ändern:** Mit der Maus über ein Bild fahren und an einer der vier Ecken ziehen (wie in OneNote); die Breite wird live in Pixeln angezeigt. Skalierte Bilder werden als `<img src="…" width="…">` gespeichert, das verstehen auch die VS-Code-Vorschau, GitHub und Obsidian.
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
