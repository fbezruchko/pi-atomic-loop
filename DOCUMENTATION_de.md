# Loop-Modul — Dokumentation (Deutsch)

> **Main documentation (English): [DOCUMENTATION.md](DOCUMENTATION.md)** — this is a German translation; the English file is authoritative.

Unbeaufsichtigter Loop-Modus für [pi](https://github.com/earendil-works/pi): Du gibst dem Agenten **ein Ziel**, und er arbeitet in kleinen Iterationen daran — stunden- oder tagelang — bis **du** ihn stoppst. Funktioniert mit kommerziellen Modellen (Claude, GPT, Gemini) genauso wie mit Open-Source-Modellen (Qwen, GLM, gpt-oss, …), weil der Loop selbst gegen typische Schwächen schwacher Modelle abgesichert ist: Wiederholungsschleifen, falsche Fertig-Behauptungen, Provider-Abbrüche.

---

## Inhalt

1. [Installation](#1-installation)
2. [Schnellstart](#2-schnellstart)
3. [Grundkonzept](#3-grundkonzept)
4. [Befehlsreferenz](#4-befehlsreferenz)
5. [Optionen im Detail](#5-optionen-im-detail)
6. [Die Goal-Funktion (`--check`)](#6-die-goal-funktion---check)
7. [Fehler- und Störfallverhalten](#7-fehler--und-störfallverhalten)
8. [Praxisbeispiele](#8-praxisbeispiele)
9. [Best Practices für Mehrtagesläufe](#9-best-practices-für-mehrtagesläufe)
10. [Statusanzeige und Monitoring](#10-statusanzeige-und-monitoring)
11. [Interna & Tuning-Konstanten](#11-interna--tuning-konstanten)
12. [FAQ](#12-faq)

---

## 1. Installation

```bash
pi install npm:pi-loop-mode
```

Oder aus einem lokalen Checkout:

```bash
pi install /pfad/zu/pi-loop-mode
```

Danach pi neu starten oder `/reload` ausführen. Der Befehl `/loop` ist dann verfügbar.

**Dateien des Pakets:**

```text
pi-loop-mode/
├── package.json              # pi-Paketdefinition
├── README.md                 # Übersicht (englisch)
├── DOCUMENTATION.md          # Hauptdokumentation (englisch)
├── DOCUMENTATION_de.md       # Diese Datei (deutsche Übersetzung)
├── CHANGELOG.md              # Versionshistorie
├── GALLERY.md                # Hinweise zu pi.dev-Gallery-Assets
├── LICENSE                   # GNU AGPL v3.0 only
├── assets/                   # pi.dev-Vorschauvideo + Posterbild
├── extensions/index.ts       # Pi-Command-/Event-Orchestrierung
├── src/                       # Wiederholung, Parsing, Zustand, Checks und begrenztes Logging
├── skills/loop-skill/SKILL.md  # Verhaltensregeln für das Modell im Loop
├── prompts/loop-prompt.md    # Prompt-Template
└── prompts/loop-examples.md  # /loop-examples — projektspezifische Loop-Rezepte
```

---

## 2. Schnellstart

**Empfohlener Workflow — Ziel setzen, vorbereiten, starten (getrennt, mit Modellwahl):**

```text
/loop goal Baue eine Task-Management-REST-API in ./taskapi: CRUD, Auth, SQLite, Tests, Docs. Committe inkrementell in git.
/loop prepare --model anthropic/claude-opus-4-6     # starkes Modell schreibt GOAL.md + check.sh
/loop run --model vllm-omega/qwen3-coder-30b        # günstiges/lokales Modell arbeitet den Loop ab
```

**Oder alles in einem Schritt** (ohne Vorbereitung, mit aktuellem Modell):

```text
/loop start Baue eine Task-Management-REST-API in ./taskapi: CRUD, Auth, SQLite, Tests, Docs. Committe inkrementell in git.
```

**Zuschauen:**

```text
/loop status
```

**Stoppen:**

```text
/loop finish   # sanft: laufende Iteration noch abschließen, dann stoppen
/loop stop     # sofort: laufenden Turn abbrechen
```

**Weitermachen:**

```text
/loop resume
```

Das ist alles, was du für den Grundbetrieb brauchst.

### Der 3-Phasen-Workflow im Detail

| Phase | Befehl | Was passiert | Typisches Modell |
|-------|--------|--------------|------------------|
| **1. Ziel setzen** | `/loop goal <Ziel> [Flags]` | Speichert Ziel + Konfiguration. **Startet nichts.** | — (kein LLM-Aufruf) |
| **2. Vorbereiten** (optional) | `/loop prepare [--model M]` | Ein Modell analysiert das Projekt und schreibt `GOAL.md` (Spezifikation, Meilensteine, Annahmen) plus ein Check-Script. Endet mit `GOAL_READY:`. Danach kannst du `GOAL.md` reviewen und editieren. | Starkes Modell (Opus, GPT-5, …) |
| **3. Loop starten** | `/loop run [--model M]` | Startet den eigentlichen Endlos-Loop. Die erste Iteration liest `GOAL.md` als Spezifikation. | Günstiges/lokales Modell (Qwen, GLM, Sonnet, …) |

Die Idee: **Planung und Ausführung entkoppeln.** Ein teures, starkes Modell schreibt einmalig eine präzise Spezifikation — ein günstiges oder lokales Modell arbeitet sie über Tage ab. `GOAL.md` liegt im Projekt, überlebt Compaction/Neustarts und wird in jedem Loop-Prompt referenziert („read it whenever you lose track of the plan“).

---

## 3. Grundkonzept

Der Loop funktioniert so:

```
┌─────────────────────────────────────────────────────┐
│  /loop start <Ziel>                                 │
└──────────────────┬──────────────────────────────────┘
                   ▼
        ┌─── Loop-Iteration ────────────────────┐
        │ 1. Loop-Prompt an das Modell          │
        │    (Ziel, Kriterien, Regeln,          │
        │     Check-Status, Iterationszähler)   │
        │ 2. Modell macht EINEN konkreten       │
        │    Fortschritts-Batch (Tools, Edits)  │
        │ 3. Goal-Check läuft (falls --check)   │
        │ 4. Auswertung:                        │
        │    Fehler? → Retry mit Backoff        │
        │    Wiederholung? → Stuck-Strategie    │
        │    Regression? → Fix-Prompt           │
        │    Fertig? → weiter verbessern        │
        │      (oder Stopp bei --until-done)    │
        │    Sonst → nächste Iteration          │
        └───────────────┬───────────────────────┘
                        │ (bis /loop stop)
                        ▼
```

**Kernprinzipien:**

- **Kleine Iterationen**: Jede Antwort max. 1.200 Zeichen, ein Fortschritts-Batch pro Turn. Dadurch bleibt der Kontext klein und pi's normale Compaction funktioniert über Tage hinweg.
- **Endlos per Default**: Kein Iterationslimit. `LOOP_DONE:` vom Modell stoppt den Loop *nicht* — stattdessen geht es mit Verbesserungsarbeit weiter (Features, Tests, Bugfixes, Refactoring, Docs).
- **Nie auf Menschen warten**: Fehlende Infos → Modell trifft eine dokumentierte Annahme (`ASSUMPTIONS.md`) und arbeitet weiter.
- **Objektive Wahrheit**: Mit `--check` entscheidet ein Shell-Kommando über Fortschritt und Completion — nicht die Selbsteinschätzung des Modells.
- **Persistenz**: Loop-Zustand liegt in der Session. Nach pi-Neustart/Reload läuft ein aktiver Loop nach 3 Sekunden automatisch weiter.

---

## 4. Befehlsreferenz

| Befehl | Beschreibung |
|--------|--------------|
| `/loop goal <Ziel> [Flags]` | Ziel + Konfiguration setzen, **ohne zu starten**. |
| `/loop goal` | Aktuelles Ziel und Konfiguration anzeigen. |
| `/loop prepare [--model M] [--file F]` | Spezifikation (`GOAL.md`) + Check-Script von einem (starken) Modell schreiben lassen. |
| `/loop run [--model M]` | Den Loop starten — optional mit anderem Modell als bei der Vorbereitung. |
| `/loop start <Ziel> [Flags]` | Abkürzung: Ziel setzen + sofort starten (ein Schritt). |
| `/loop <Ziel>` | Kurzform für `/loop start <Ziel>`. |
| `/loop resume [--max N] [--check "CMD"] [--model M] [--rescue-model M]` | Gestoppten/pausierten Loop fortsetzen, optional mit neuem Limit/Check/Modell. |
| `/loop status` | Vollständigen Zustand anzeigen. |
| `/loop stats` | Statistik aus dem Iterations-Log (`.pi-loop-log.jsonl`): Events, Interventionen, produktive Iterationen/h, Score-Verlauf. |
| `/loop finish` | Soft-Stop: laufende Iteration wird noch abgeschlossen, danach kein neuer Turn (Zustand bleibt für `/loop resume` erhalten). Alias: `/loop soft-stop`. |
| `/loop stop` | Hard-Stop: laufenden Turn sofort abbrechen, Zustand bleibt erhalten. |
| `/loop end` | Beenden und Zustand löschen. |
| `/loop help` | Kurzhilfe. |

**Flags** (gültig bei `goal`, `start` und teils bei `prepare`/`run`/`resume`):

| Flag | Beschreibung |
|------|--------------|
| `--max N` | Iterationslimit (Default: ∞). |
| `--delay S` | Pause zwischen Iterationen in Sekunden. |
| `--check "CMD"` | Objektive Goal-Funktion (siehe [Abschnitt 6](#6-die-goal-funktion---check)). |
| `--check-timeout S` | Check-Timeout in Sekunden (Default 120). |
| `--file GOAL.md` | Name der Spezifikationsdatei (Default `GOAL.md`). |
| `--model M` | Modell für diese Phase: `provider/id` (z. B. `anthropic/claude-opus-4-6`) oder eindeutiger Teilname (z. B. `qwen3-coder`). |
| `--rescue-model M` | Stärkeres Modell, das nach 3 Stuck-Interventionen in Folge für **einen** Aufräum-Turn übernimmt (siehe [Abschnitt 7](#7-fehler--und-störfallverhalten)). |
| `--until-done` | Loop stoppt bei verifizierter Completion. |

**Syntax des Ziels:** Alles vor `Done when:` ist das Ziel, alles danach sind die Kriterien:

```text
/loop start Implementiere Feature X. Done when: Tests grün und README aktualisiert.
```

Ohne `Done when:` läuft der Loop im reinen Verbesserungsmodus („continuous improvement until the operator stops the loop“).

### Modellwahl (`--model`)

Jede Phase kann ein eigenes Modell verwenden:

```text
/loop goal Baue X …                                  # kein LLM-Aufruf
/loop prepare --model anthropic/claude-opus-4-6       # Planung: starkes Modell
/loop run --model vllm-omega/qwen3-coder-30b          # Ausführung: lokales Modell
```

- Format: `provider/id` (exakt) oder ein eindeutiger Teilstring der Modell-ID (`--model qwen3-coder` findet `vllm-omega/qwen3-coder-30b`).
- Das bei `run` gewählte Modell wird als **Loop-Modell gespeichert**: Nach pi-Neustart/Reload stellt der Auto-Resume dieses Modell wieder her (mit Warnung, falls nicht verfügbar — dann läuft der Loop mit dem aktuellen Modell weiter).
- Unbekanntes Modell oder fehlender API-Key → klare Fehlermeldung, der Loop startet **nicht**.
- Ohne `--model` verwendet die jeweilige Phase einfach das aktuell aktive Modell.
- Mitten im Lauf wechseln: `/loop stop`, dann `/loop resume --model <anderes Modell>`.

### Rescue-Modell (`--rescue-model`)

Für lange Läufe mit schwachen/lokalen Modellen dringend empfohlen:

```text
/loop run --model vllm-omega/qwen3-coder-30b --rescue-model anthropic/claude-sonnet-4-5
```

Bleibt das Loop-Modell 3× in Folge hängen, übernimmt das Rescue-Modell für genau **einen Turn**: Es inspiziert den Projektzustand, erledigt eine konkrete Sache, schreibt `PROGRESS.md` neu (nächste 3 eindeutige Schritte mit Dateipfaden), aktualisiert das `IMPROVEMENTS.md`-Backlog und hinterlässt eine `NEXT:`-Zeile. Danach läuft der Loop mit dem regulären Modell weiter — schwache Modelle folgen einem klaren fremden Plan deutlich besser, als selbst einen zu erstellen.

### Die Vorbereitung (`/loop prepare`)

`/loop prepare` schickt einen einmaligen Auftrag an das Modell (kein Loop!):

1. Projektzustand inspizieren (Dateien, README, Tests).
2. `GOAL.md` schreiben: verfeinertes Ziel, Scope & Non-Goals, messbare Fertig-Kriterien, Meilenstein-Roadmap in kleinen Schritten, Qualitätsstandards (Tests, Docs, git-Commits), explizite Annahmen.
3. Falls objektiv prüfbar: ein Check-Script (`check.sh`) erzeugen und in `GOAL.md` referenzieren.
4. Abschluss mit `GOAL_READY: <Zusammenfassung>` — daran erkennt die Extension die fertige Vorbereitung und empfiehlt das exakte `--check`-Kommando.

Danach: **`GOAL.md` reviewen und bei Bedarf von Hand editieren** — erst `/loop run` startet den Loop. Der Loop-Prompt verweist ab dann in jeder Iteration auf die Spezifikation; die erste Iteration beginnt explizit mit dem Lesen von `GOAL.md`.

---

## 5. Optionen im Detail

### `--max N` — Iterationslimit

Default: **unbegrenzt** (∞). Mit `--max 50` pausiert der Loop nach 50 Iterationen. `/loop resume` setzt fort — ist das Limit ausgeschöpft, wird automatisch auf unbegrenzt umgestellt (mit Hinweis).

Sinnvoll für: erste Testläufe mit einem neuen Modell, Kostenkontrolle bei kommerziellen APIs.

### `--delay S` — Pause zwischen Iterationen

Default: **0 s**. Mit `--delay 30` wartet der Loop 30 Sekunden zwischen den Iterationen.

Sinnvoll für: Rate-Limits bei kommerziellen APIs, Schonung lokaler GPU-Ressourcen, wenn parallel andere Jobs laufen.

### `--until-done` — Klassischer „bis fertig"-Modus

Default: **aus** (Endlos-Modus). Mit `--until-done` stoppt der Loop bei Completion:

- **Mit `--check`**: Der Loop stoppt, sobald das Check-Kommando Exit-Code 0 liefert — *verifizierte* Completion, unabhängig davon, was das Modell behauptet.
- **Ohne `--check`**: Der Loop stoppt, wenn das Modell `LOOP_DONE:` meldet (Selbstauskunft — bei schwachen Modellen unzuverlässig, daher `--check` empfohlen).

### `--check "CMD"` / `--check-timeout S`

Siehe nächster Abschnitt.

---

## 6. Die Goal-Funktion (`--check`)

Die Goal-Funktion ist ein Shell-Kommando (ausgeführt via `bash -lc`), das **nach jeder Iteration** läuft. Sie ist die objektive Fitness-Funktion des Loops.

### Vertrag

| Signal | Bedeutung |
|--------|-----------|
| **Exit-Code 0** | Fertig-Kriterien erfüllt. Bei `--until-done`: Loop stoppt (verifizierte Completion). |
| **Exit-Code ≠ 0** | Kriterien noch nicht erfüllt. Loop läuft weiter. |
| **`SCORE: <Zahl>`** im Output (optional) | Numerischer Fortschritts-Score, höher = besser. Auch negativ/dezimal erlaubt. Bei mehreren Vorkommen zählt das letzte. |

### Was der Check dem Loop gibt

1. **Verifizierte Completion** — Bei `--until-done` entscheidet der Exit-Code, nicht die Behauptung des Modells. Meldet das Modell `LOOP_DONE:`, während der Check fehlschlägt, wird die Behauptung zurückgewiesen: *„Completion is decided by the check, not by your claim. Fix exactly what the check reports"* — inklusive Check-Output im Prompt.
2. **Regressions-Erkennung** — Fällt der Score gegenüber dem letzten Lauf, bekommt das Modell sofort einen Regression-Prompt: aktuelle Änderungen prüfen (`git diff`/`git log`), Regression fixen, bevor irgendetwas anderes passiert. Kritisch bei Mehrtagesläufen, wo ein Refactoring still Tests bricht.
3. **Echter Fortschrittsnachweis** — Ein neuer Best-Score zählt als messbarer Fortschritt und füttert den No-Progress-Audit (siehe [Abschnitt 7](#7-fehler--und-störfallverhalten)).
4. **Objektives Feedback** — Jeder Loop-Prompt enthält den aktuellen Check-Status:

```text
Goal check: `./check.sh` → FAILING (streak 3) · score 34 (best 41 @ iteration 87)
```

Das Modell optimiert damit gegen eine messbare Größe statt gegen die eigene Selbsteinschätzung.

### Beispiel-Check-Scripts

**Einfach — Tests müssen durchlaufen:**

```bash
/loop start Fixe alle Bugs in ./app. Done when: Testsuite grün --check "cd app && npm test" --until-done
```

**Mit Score — Anzahl grüner Tests:**

```bash
#!/usr/bin/env bash
# check.sh — Fitness-Funktion für einen API-Bau-Lauf
cd taskapi || { echo "SCORE: 0"; exit 1; }

# Build muss funktionieren, sonst Score 0
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }

# Score = Anzahl bestandener Tests
passed=$(npm test 2>/dev/null | grep -oE '[0-9]+ passing' | grep -oE '[0-9]+' || echo 0)
echo "SCORE: $passed"

# Fertig ab 50 bestandenen Tests
[ "$passed" -ge 50 ] && exit 0 || exit 1
```

**Mehrdimensionaler Score — Tests + Coverage − Lint-Warnungen:**

```bash
#!/usr/bin/env bash
cd myproject || { echo "SCORE: -1000"; exit 1; }
go build ./... >/dev/null 2>&1 || { echo "SCORE: -1000"; exit 1; }

tests=$(go test ./... 2>/dev/null | grep -c '^ok' || echo 0)
coverage=$(go test -cover ./... 2>/dev/null | grep -oE '[0-9]+\.[0-9]+%' | tr -d '%' | awk '{s+=$1; n++} END {print (n ? int(s/n) : 0)}')
lint=$(golangci-lint run 2>/dev/null | wc -l | tr -d ' ')

score=$(( tests * 10 + coverage - lint ))
echo "SCORE: $score"

# Fertig: alle Pakete ok, Coverage ≥ 80 %, keine Lint-Warnungen
[ "$coverage" -ge 80 ] && [ "$lint" -eq 0 ] && go test ./... >/dev/null 2>&1 && exit 0
exit 1
```

**Webprojekt — Endpunkte + E2E:**

```bash
#!/usr/bin/env bash
cd webapp || exit 1
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }
unit=$(npx vitest run --reporter=json 2>/dev/null | jq '.numPassedTests' 2>/dev/null || echo 0)
e2e=$(npx playwright test --reporter=json 2>/dev/null | jq '.stats.expected' 2>/dev/null || echo 0)
echo "SCORE: $(( unit + e2e * 5 ))"   # E2E-Tests höher gewichten
[ "$e2e" -ge 10 ] && exit 0 || exit 1
```

### Score-Ideen

- Anzahl bestandener Tests / E2E-Tests
- Test-Coverage in Prozent
- Anzahl implementierter API-Endpunkte (z. B. via `grep -c 'app\.\(get\|post\|put\|delete\)'`)
- Negierte Fehleranzahl: `SCORE: -$(eslint . 2>/dev/null | wc -l)`
- Feature-Checkliste: `SCORE: $(grep -c '^\- \[x\]' FEATURES.md)`
- Kombinationen mit Gewichtung (siehe oben)

### Regeln für gute Check-Scripts

- **Schnell halten** (< 2 min; sonst `--check-timeout` erhöhen). Der Check läuft nach *jeder* Iteration.
- **Deterministisch**: keine flaky Tests im Check — jeder Score-Sprung nach unten löst einen Regression-Prompt aus.
- **Robust**: das Script selbst darf nie hängen; nutze eigene Timeouts für Teilschritte (`timeout 60 npm test`).
- **Monoton sinnvoll**: der Score soll steigen, wenn das Produkt besser wird. Nicht: „Anzahl Dateien" (lädt zu Müllproduktion ein).
- Schlägt das Check-Kommando selbst fehl (z. B. nicht gefunden), zeigt der Loop eine Warnung und läuft **ohne Blockade** weiter.

---

## 7. Fehler- und Störfallverhalten

Der Loop ist darauf ausgelegt, tagelang ohne Aufsicht zu laufen. Übersicht aller Situationen:

| Situation | Verhalten |
|-----------|-----------|
| **Temporärer Model-/Provider-Fehler** (Crash, Rate-Limit, Timeout, leere Antwort, `stopReason: "error"`) | Automatischer Retry mit exponentiellem Backoff: 5 s → 10 s → 20 s → … → max. 5 min. Danach „recover"-Prompt: kurz orientieren und weitermachen. |
| **Kontextdruck-Fehler** (`length` mit ≤32 Output-Tokens oder ein 400-/Kontext-/Token-Fehler bei ≥85 % Kontext) | LLM-unabhängige Notfall-Compaction, danach ein Recovery-Turn. Zwei Notfallversuche sind erlaubt; der dritte Fehler in Folge pausiert mit erhaltenem Zustand statt endlos weiterzuretryen. |
| **Modell wiederholt dieselbe Antwort** (Fingerprint-Vergleich, 2× identisch) | Stuck-Intervention: rotierende Recovery-Strategie wird injiziert (siehe unten), mit eskalierendem Delay 2 s → 4 s → … → 60 s. **Pausiert nie.** |
| **Modell wiederholt fast dieselbe Antwort** (≥ 80 % Ähnlichkeit auf Wort-Trigrammen, Zahlen maskiert — fängt Umformulierungen wie „Already exists. Let me continue with improvements…" ab) | Ebenfalls Stuck-Intervention. |
| **Dieselbe Antwort 3×+ im jüngeren Verlauf** (auch alternierend A-B-A-B) | Ebenfalls Stuck-Intervention. |
| **3 Turns ohne einen einzigen Tool-Aufruf** (reines Erzählen statt Arbeiten) | Ebenfalls Stuck-Intervention. |
| **Degenerierte Generierung** (derselbe Satz ≥ 4×, ein Wort ≥ 16× direkt hintereinander oder eine Phrase mit bis zu vier Wörtern ≥ 8× direkt hintereinander in *einer* Antwort) | Antwort wird gekürzt gespeichert (Kontext-Hygiene) + Stuck-Intervention. Satzschleifen werden beim Streamen ab ≥ 6 Wiederholungen abgebrochen; Wort-/Phrasenläufe bei ihren jeweiligen Schwellen. Der Abbruch geht in die automatische Stuck-Recovery statt zu pausieren. |
| **Dasselbe Tool-Ergebnis/-Fehler 3× hintereinander** | Ebenfalls Stuck-Intervention. |
| **Dieselbe Frage 2× wiederholt** | Ebenfalls Stuck-Intervention. |
| **3 Stuck-Interventionen hintereinander** | Hard-Reset-Eskalation: die letzten Antwort-Anfänge werden als verbotene Formulierungen injiziert; die erste Aktion des Turns **muss** ein Tool-Aufruf sein (kein Text davor). Falls `--rescue-model` gesetzt: stattdessen Rescue-Turn (siehe unten). |
| **5 Stuck-Interventionen hintereinander** | Auto-Compaction: der Kontext wird komprimiert (repetitive Füllsätze werden explizit aus der Zusammenfassung ausgeschlossen), damit das Wiederholungsmuster aus dem Kontextfenster verschwindet. |
| **8 Iterationen ohne konkrete Änderung** (keine Datei-Writes/Edits, kein Score-Anstieg) | Audit-Prompt: „Hör auf zu analysieren, produziere jetzt ein greifbares Artefakt: Dateiänderung, grüner Test, gefixter Bug oder Commit." |
| **Modell meldet `LOOP_DONE:`** (Endlos-Modus) | Loop läuft weiter mit „improve"-Prompt: wertvollste nächste Verbesserung wählen und umsetzen. |
| **Modell meldet `LOOP_DONE:`, Check schlägt fehl** (`--until-done`) | Behauptung wird zurückgewiesen; „check_failed"-Prompt mit Check-Output. |
| **Check-Score fällt** | Sofortiger „regression"-Prompt: Diffs prüfen, Regression fixen. |
| **Check besteht** (`--until-done`) | Verifizierte Completion — Loop stoppt. |
| **Modell meldet `LOOP_BLOCKED:`** | Loop pausiert **nicht**. „unblock"-Prompt: sinnvollste Annahme treffen, in `ASSUMPTIONS.md` dokumentieren, weiterarbeiten. |
| **Operator drückt Esc** (Turn abgebrochen) | Loop pausiert bewusst (Operator-Wille). `/loop resume` setzt fort. |
| **`/loop finish`** (Soft-Stop) | Laufende Iteration wird noch abgeschlossen, dann stoppt der Loop ohne neuen Turn. Zustand bleibt für `/loop resume` erhalten; überlebt auch einen pi-Neustart (wird beim Start finalisiert statt auto-resumed). |
| **pi-Neustart / `/reload`** | Aktiver Loop resumed automatisch nach 3 s (mit Hinweis und Abbruchmöglichkeit via `/loop stop`). |
| **`--max N` erreicht** | Loop pausiert. `/loop resume` setzt fort (entfernt das Limit, wenn ausgeschöpft). |

### Die rotierenden Stuck-Strategien

Bei erkannter Wiederholung wird reihum eine dieser Strategien injiziert:

1. Drei wirklich unterschiedliche Ansätze in je einer Zeile auflisten, den vielversprechendsten sofort ausführen.
2. Zu einem anderen Teilbereich des Ziels wechseln, der zuletzt nicht angefasst wurde.
3. `PROGRESS.md` schreiben/aktualisieren: aktueller Stand, was versucht wurde, was scheiterte, nächste 3 Schritte — dann Schritt 1 ausführen.
4. Build/Testsuite laufen lassen, genau **einen** Fehler oder eine Warnung fixen.
5. Letzte Änderungen reviewen (`git diff` / `git log`), Korrektheit prüfen, gefundene Probleme fixen.

Diese Rotation verhindert, dass die Intervention selbst zur Schleife wird — wichtig bei schwächeren Open-Source-Modellen.

Zusätzliche Schutzmechanismen gegen Endlos-Geschwafel schwächerer Modelle:

- **Near-Duplicate-Erkennung**: Antworten werden nicht nur exakt (Hash), sondern per Trigramm-Ähnlichkeit verglichen (Zahlen maskiert). Leicht umformulierte Wiederholungen („Already exists. Let me continue with improvements…") werden so trotzdem erkannt.
- **Tool-Pflicht**: Jeder Loop-Prompt fordert mindestens einen Tool-Aufruf pro Turn. Drei Turns ohne Tool-Nutzung lösen eine Stuck-Intervention aus.
- **Hard-Reset-Eskalation**: Ab der 3. Stuck-Intervention in Folge werden die letzten Antwortanfänge als verbotene Phrasen mitgegeben und der Turn muss mit einem Tool-Aufruf beginnen.
- **Degenerations-Kill-Switch**: Wiederholt das Modell im sichtbaren Text oder im Thinking/Reasoning denselben Satz vielfach, ein Wort 16× direkt hintereinander oder eine kurze Phrase mit bis zu vier Wörtern 8× direkt hintereinander, wird der Stream live abgebrochen, die Antwort in der Session gekürzt und vor jedem LLM-Call sowohl Text- als auch Thinking-Kontext bereinigt. Der Abbruch geht in die automatische Stuck-Recovery; der unbeaufsichtigte Loop läuft weiter und der Müll kann sich nicht selbst verstärken.
- **Sampling-Penalties**: Nach jeder Stuck-Intervention werden für 3 Iterationen `frequency_penalty`/`presence_penalty` (0.5) gesetzt und die Temperature leicht erhöht — nur bei OpenAI-kompatiblen APIs (vLLM, Ollama). Das bekämpft Wiederholung auf Sampling-Ebene, wo Prompts allein oft nicht reichen.
- **Rescue-Modell** (`--rescue-model M`): Ab 3 Stuck-Interventionen in Folge übernimmt ein stärkeres Modell für einen Turn, räumt auf und hinterlässt einen klaren Plan (`PROGRESS.md`, `IMPROVEMENTS.md`, `NEXT:`-Zeile).
- **Auto-Compaction**: Ab 5 Stuck-Interventionen in Folge wird der Kontext komprimiert — ein frisches Kontextfenster bricht Fixpunkte oft besser als jede Prompt-Intervention.
- **Notfall-Kontext-Recovery**: Bei Kontext-Sättigung kann Loop Mode das bereits scheiternde Zusammenfassungsmodell umgehen. Eine begrenzte lokale Zusammenfassung entsteht aus Loop-Zustand, Datei-Metadaten und Ausschnitten aus `GOAL.md`, `PROGRESS.md`, `IMPROVEMENTS.md` und `ASSUMPTIONS.md`. Normale Pi-Compaction bleibt der bevorzugte Weg.
- **Circuit-Breaker**: Nach zwei Notfall-Recoveries ohne erfolgreichen Assistant-Turn pausiert der dritte Kontextdruck-Fehler. Nach der Kontextreparatur `/compact` und `/loop resume` verwenden; normale temporäre Provider-Ausfälle behalten ihr Backoff.
- **Prompt-Variation**: Der „continue"-Prompt wird leicht variiert formuliert — identische Prompts begünstigen identische (repetitive) Antworten.
- **Backlog-getriebener Improve-Modus**: Nach `LOOP_DONE` im Endlos-Modus arbeitet der Loop über ein `IMPROVEMENTS.md`-Backlog: konkrete Items mit Dateipfaden und Akzeptanzkriterium; vage Items („add support for other platforms") sind verboten. Oberstes Item umsetzen, abhaken.

### Compaction-Einstellungen für Modelle mit sehr großem Kontext

Pi's Defaults passen für die meisten Modelle. Für ein 512k-Modell mit 65.536 Output-Tokens und tool-lastigen Turns empfiehlt sich eine projektlokale `.pi/settings.json`:

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 65536,
    "keepRecentTokens": 150000
  }
}
```

Damit startet die normale Compaction bei ungefähr 87,5 % und der ältere Teil für den Summarizer bleibt deutlich unter dem Modelllimit. Diese absoluten Werte gelten speziell für ein 512k-Kontextfenster. Scheitert die normale Zusammenfassung trotzdem, nutzt ein gesättigtes manuelles `/compact` die lokale Notfall-Zusammenfassung.

### Iterations-Log und `/loop stats`

Jedes Loop-Ereignis (continue, stuck, rescue, compact, error, done, soft_stop, …) wird als JSONL-Zeile in `.pi-loop-log.jsonl` im Arbeitsverzeichnis protokolliert (Timestamp, Iteration, Event, Modell, Score, Stuck-Streak). Die aktive Datei ist auf 5 MiB begrenzt und wird in genau ein `.pi-loop-log.jsonl.1`-Backup rotiert; damit bleiben knapp 10 MiB erhalten. `/loop stats` liest nur diese begrenzten Dateien, ignoriert defekte Zeilen und fasst Event-Verteilung, Interventionen, produktive Iterationen pro Stunde sowie den Score-Verlauf zusammen.

---

## 8. Praxisbeispiele

> **Tipp:** `/loop-examples [Fokus]` (z. B. `/loop-examples tests`) analysiert das aktuelle Projekt und schlägt fertige, zugeschnittene `/loop`-Kommandos vor — mit echten Pfaden, den tatsächlichen Test-/Build-Befehlen als `--check` und Modell-Empfehlungen für schwächere Modelle. Fokus-Werte: `features`, `bugs`, `tests`, `refactor`, `docs`, `quality`.

### Beispiel 1: 5-Tage-Produktlauf mit Modell-Trennung (dein Kern-Use-Case)

```text
# Phase 1: Ziel definieren (startet nichts)
/loop goal Baue in ./taskapi eine produktionsreife Task-Management-REST-API (Node.js/Express, SQLite): CRUD für Tasks/Projekte/Tags, JWT-Auth, Validierung, OpenAPI-Doku, umfassende Tests. Arbeite in git, committe jede abgeschlossene Einheit. Verbessere kontinuierlich: neue Features, mehr Tests, Bugfixes, Refactoring, Performance. --check "cd taskapi && ./check.sh" --delay 10

# Phase 2: Starkes Modell schreibt GOAL.md + check.sh (~1 Turn, dann GOAL_READY)
/loop prepare --model anthropic/claude-opus-4-6

# → GOAL.md reviewen, ggf. anpassen …

# Phase 3: Lokales/günstiges Modell arbeitet tagelang
/loop run --model vllm-omega/qwen3-coder-30b
```

mit `taskapi/check.sh`:

```bash
#!/usr/bin/env bash
cd "$(dirname "$0")" || exit 1
npm run build >/dev/null 2>&1 || { echo "SCORE: 0"; exit 1; }
passed=$(timeout 90 npm test 2>/dev/null | grep -oE '[0-9]+ passing' | grep -oE '[0-9]+' || echo 0)
endpoints=$(grep -rcE 'router\.(get|post|put|delete)' src/routes/ 2>/dev/null | awk -F: '{s+=$2} END {print s+0}')
echo "SCORE: $(( passed * 2 + endpoints ))"
exit 1   # Endlos-Modus: nie "fertig", immer weiter verbessern
```

Der Loop läuft endlos, der Score wächst mit Tests und Endpunkten, Regressionen werden sofort erkannt. Das Qwen-Modell folgt der von Opus geschriebenen Spezifikation. Nach 5 Tagen: `/loop stop`.

**Modell mitten im Lauf wechseln** (z. B. weil das lokale Modell an einem Meilenstein scheitert):

```text
/loop stop
/loop resume --model anthropic/claude-sonnet-4-5
```

### Beispiel 2: Bug-Jagd bis alles grün ist

```text
/loop start Fixe alle fehlschlagenden Tests in diesem Repo. Done when: gesamte Testsuite grün. --check "npm test" --until-done
```

Stoppt automatisch und verifiziert, sobald `npm test` mit Exit 0 durchläuft — egal was das Modell zwischendurch behauptet.

### Beispiel 3: Test-Coverage hochtreiben

```text
/loop start Erhöhe die Testabdeckung von ./src auf mindestens 90 %. Schreibe sinnvolle Tests, keine Mocks von allem. --check "./coverage-check.sh" --until-done --check-timeout 300
```

```bash
#!/usr/bin/env bash
# coverage-check.sh
cov=$(npx vitest run --coverage 2>/dev/null | grep -oE 'All files[^0-9]+[0-9]+\.[0-9]+' | grep -oE '[0-9]+\.[0-9]+' | head -1)
cov=${cov%%.*}
echo "SCORE: ${cov:-0}"
[ "${cov:-0}" -ge 90 ] && exit 0 || exit 1
```

### Beispiel 4: Vorsichtiger Erstlauf mit einem neuen Open-Source-Modell

```text
/loop start Refactoriere ./legacy nach TypeScript, Modul für Modul. Committe nach jedem Modul. --max 20 --delay 15 --check "cd legacy && npx tsc --noEmit && npm test"
```

`--max 20` begrenzt den Testlauf. Danach Ergebnis prüfen und mit `/loop resume --max 100` (oder ohne Limit) weiterlaufen lassen.

### Beispiel 5: Doku-Pflege über Nacht

```text
/loop start Vervollständige die Dokumentation in ./docs: jede öffentliche Funktion dokumentiert, Beispiele für alle Module, README auf aktuellem Stand. Verbessere kontinuierlich Klarheit und Vollständigkeit.
```

Ohne `--check` (Doku-Qualität ist schwer messbar) — der No-Progress-Audit sorgt trotzdem dafür, dass tatsächlich Dateien geändert werden.

### Beispiel 6: Lint-Schulden abbauen (negativer Score)

```text
/loop start Beseitige alle ESLint-Warnungen und -Fehler im Repo, ohne Funktionalität zu ändern. Done when: eslint meldet nichts mehr. --check "./lint-check.sh" --until-done
```

```bash
#!/usr/bin/env bash
count=$(npx eslint . 2>/dev/null | grep -cE 'warning|error')
echo "SCORE: $(( -count ))"
[ "$count" -eq 0 ] && exit 0 || exit 1
```

Score startet z. B. bei −347 und arbeitet sich Richtung 0. Jede neue Warnung (Regression) fällt sofort auf.

---

## 9. Best Practices für Mehrtagesläufe

1. **In einem git-Repository arbeiten** und das im Ziel explizit fordern („committe jede abgeschlossene Einheit"). Commits überleben Compaction, Neustarts und Kontextverlust — und Regressionen lassen sich per `git diff` finden.
2. **Immer `--check` verwenden**, wenn irgendetwas messbar ist. Die Goal-Funktion ist der stärkste Hebel gegen Modell-Halluzinationen.
3. **`PROGRESS.md` einfordern** — steht auch in den Skill-Regeln. Nach Compaction oder Neustart orientiert sich das Modell daran.
4. **`--delay` bei kommerziellen APIs** setzen (z. B. 10–30 s), um Rate-Limits und Kosten zu steuern; bei lokalen Modellen meist 0.
5. **Erstlauf mit `--max 15–25`** bei einem unbekannten Modell: Verhalten prüfen, dann `/loop resume` ohne Limit.
6. **Ziel konkret formulieren**: Technologie, Verzeichnis, Qualitätsansprüche, Verbesserungsrichtungen. „Baue etwas Cooles" produziert Drift; das Beispiel 1 oben ist das richtige Detailniveau.
7. **Sandbox beachten**: Der Loop arbeitet unbeaufsichtigt mit vollen Tool-Rechten. Für lange Läufe ein dediziertes Verzeichnis/Repo verwenden, idealerweise VM/Container, keine Produktionssysteme im Zugriff.
8. **Check-Script versionieren** (ins Repo committen) — dann kann das Modell es lesen und versteht, woran es gemessen wird. Aber im Ziel klarstellen, dass das Check-Script nicht manipuliert werden darf.

---

## 10. Statusanzeige und Monitoring

**Statusbar** (Footer, live):

```text
Loop 142/∞ · 1d 7h 23m · err 3 · score 87: Baue in ./taskapi eine produktionsreife…
```

- `142/∞` — Iterationen / Limit
- `1d 7h 23m` — Laufzeit
- `err 3` — Model-/Provider-Fehler gesamt (alle automatisch überstanden)
- `score 87` — letzter Check-Score (oder `check ✓`/`check ✗` ohne Score)

**`/loop status`** zeigt den vollen Zustand:

```text
Active: true
Status: running
Goal: Baue in ./taskapi eine produktionsreife Task-Management-REST-API …
Criteria: - (endless improvement)
Mode: endless
Iterations: 142/∞
Delay: 10s
Check: cd taskapi && ./check.sh (timeout 120s)
Check status: failing (streak 2), score 87 (best 91 @ iter 138)
Goal file: GOAL.md (prepared)
Loop model: vllm-omega/qwen3-coder-30b
Rescue model: anthropic/claude-sonnet-4-5
Elapsed: 1d 7h 23m
Errors: 3 total, 0 consecutive
Interventions: 7 (stuck streak: 0)
Done signals: 2, blocked signals: 1
Last notice: -
Session entries: 4211
```

Interessante Felder:
- **Interventions** — wie oft Stuck-/Audit-/Regression-Prompts nötig waren (hoher Wert → Modell kämpft; Ziel ggf. konkreter fassen oder stärkeres Modell wählen).
- **Done signals** — wie oft das Modell „fertig" gemeldet hat (im Endlos-Modus normal und harmlos).
- **Check status** — `streak` zählt aufeinanderfolgende Fehlschläge des Checks; `best @ iter` zeigt, wann der Bestwert erreicht wurde.

**`/loop stats`** wertet das Iterations-Log `.pi-loop-log.jsonl` aus (aktueller Lauf, sonst alle Läufe):

```text
Loop stats (current run, 214 entries, .pi-loop-log.jsonl):
Events: continue 187, stuck 14, done 6, rescue_start 3, compact 1, error 3
Interventions: 18 (rescue 3, compact 1)
Productive iterations/h: 11.2
Score: first 12, best 91, last 87
```

Damit vergleichst du, welches Modell bzw. welche Goal-Formulierung stabil läuft (wenig Interventionen, hohe produktive Rate, steigender Score). Die Datei liegt im Arbeitsverzeichnis — ggf. in `.gitignore` aufnehmen.

---

## 11. Interna & Tuning-Konstanten

Konstanten am Anfang von `extensions/index.ts`:

| Konstante | Wert | Bedeutung |
|-----------|------|-----------|
| `BASE_BACKOFF_SECONDS` | 5 | Start-Backoff nach Model-Fehler. |
| `MAX_BACKOFF_SECONDS` | 300 | Backoff-Obergrenze (5 min). |
| `NO_PROGRESS_WINDOW` | 8 | Iterationen ohne konkrete Änderung bis zum Audit-Prompt. |
| `AUTO_RESUME_DELAY_MS` | 3000 | Wartezeit vor Auto-Resume nach Neustart. |
| `MAX_STORED_TEXT` | 280 | Snippet-Länge für persistierte Fingerprints. |
| `SIMILARITY_THRESHOLD` | 0.8 | Jaccard-Schwelle für Near-Duplicate-Antworten. |
| `REPEAT_WINDOW_COUNT` | 3 | Gleicher Fingerprint N× im jüngeren Verlauf = stuck. |
| `MAX_TOOLLESS_TURNS` | 3 | Turns ohne Tool-Aufruf bis zur Stuck-Intervention. |
| `HARD_RESET_AFTER` | 3 | Stuck-Streak bis zur Hard-Reset-Eskalation. |
| `DEGENERATE_REPEATS` | 4 | Satz-Wiederholungen in einer Antwort = degeneriert. |
| `DEGENERATE_STREAM_REPEATS` | 6 | Satzwiederholungen, ab denen mid-stream abgebrochen wird. |
| `DEGENERATE_WORD_REPEATS` | 16 | Direkte Wiederholungen eines Wortes = degeneriert. |
| `DEGENERATE_PHRASE_REPEATS` | 8 | Direkte Wiederholungen einer kurzen Phrase = degeneriert. |
| `DEGENERATE_MAX_PHRASE_WORDS` | 4 | Maximale Tokenbreite einer wiederholten Phrase. |
| `RESCUE_AFTER` | 3 | Stuck-Streak bis zum Rescue-Turn (falls `--rescue-model`). |
| `COMPACT_AFTER` | 5 | Stuck-Streak bis zur Auto-Compaction. |
| `PENALTY_TURNS` | 3 | Iterationen mit Sampling-Penalties nach einer Intervention. |
| `LOG_FILE` | `.pi-loop-log.jsonl` | Aktives Iterations-Log für `/loop stats`. |
| `MAX_LOG_BYTES` | 5 MiB | Limit pro Datei; ein `.1`-Backup bleibt erhalten. |
| `CONTEXT_PRESSURE_PERCENT` | 85 | Kontextauslastung, ab der Length-/Kontextfehler für die Notfall-Recovery gelten. |
| `LOW_OUTPUT_LENGTH_TOKENS` | 32 | Maximale Ausgabe bei einem `length`-Stopp, der unabhängig vom Prozentwert als Kontextdruck gilt. |
| `MAX_EMERGENCY_SUMMARY_CHARS` | 24.000 | Harte Grenze der LLM-unabhängigen Notfall-Zusammenfassung. |

**Wie die Erkennung funktioniert:**

- *Wiederholungserkennung*: SHA-256-Fingerprint über normalisierten Antworttext (Whitespace/ANSI entfernt, lowercase, erste 4.000 Zeichen). Verglichen werden die letzten 5 Assistant-Antworten und die letzten 10 Tool-Ergebnisse. Fehler-Turns (`stopReason: error/aborted`) fließen nicht in die Fingerprints ein.
- *Fortschrittserkennung*: `write`/`edit`-Toolaufrufe, Erfolgs-Keywords in Tool-Outputs (`created`, `passed`, `committed`, …) oder ein neuer Check-Bestscore.
- *Persistenz*: Zustand wird als Custom-Session-Entry (`loop-state`) via `pi.appendEntry()` gespeichert — landet **nicht** im LLM-Kontext.
- *Goal-Check*: läuft via `pi.exec("bash", ["-lc", CMD])` mit Timeout; `SCORE:`-Parsing per Regex (letztes Vorkommen zählt, auch negative/dezimale Werte).
- *Kontexthygiene*: Der Loop injiziert pro Iteration nur einen kompakten Prompt (Ziel + Regeln + Check-Status) und erlaubt pi's normale Compaction — die Session wird nie komplett re-injiziert.

---

## 12. FAQ

**Warum stoppt der Loop nicht, wenn das Modell „fertig" sagt?**
Weil das dein Anwendungsfall ist: ein Produkt, das über Tage kontinuierlich wächst. `LOOP_DONE:` führt im Endlos-Modus zum „improve"-Prompt (nächstes Feature, mehr Tests, Bugfix, …). Willst du klassisches „bis fertig", nutze `--until-done` — idealerweise mit `--check`.

**Das Modell behauptet, Tests seien grün, aber sie sind es nicht.**
Genau dafür gibt es `--check`. Der Loop glaubt nur dem Exit-Code des Check-Kommandos, nie der Behauptung des Modells.

**Was passiert bei einem Rate-Limit mitten in der Nacht?**
Retry mit exponentiellem Backoff bis max. 5 min zwischen Versuchen, unbegrenzt oft. Am Morgen zeigt `err N` in der Statusbar, wie oft es geklemmt hat.

**Kann ich Planung und Ausführung mit verschiedenen Modellen machen?**
Ja — das ist der empfohlene Workflow: `/loop goal <Ziel>` (setzt nur das Ziel), `/loop prepare --model <starkes Modell>` (schreibt `GOAL.md` + Check-Script), `/loop run --model <günstiges Modell>` (arbeitet die Spezifikation ab). Das Loop-Modell wird gespeichert und beim Auto-Resume nach Neustart wiederhergestellt.

**Was passiert mit GOAL.md nach der Vorbereitung?**
Sie liegt als normale Datei im Projekt — du kannst sie vor `/loop run` reviewen und editieren. Der Loop verweist in jedem Prompt darauf; das Arbeitsmodell liest sie in der ersten Iteration und immer dann, wenn es den Faden verliert.

**Kann ich während des Loops eingreifen?**
Ja. Eine normale Nachricht wird als Steering in den Loop eingespeist. `Esc` pausiert den Loop (bewusst — Operator-Wille), `/loop resume` setzt fort.

**Frisst der Loop nicht irgendwann den ganzen Kontext?**
Pi's automatische Compaction ist der primäre Schutz. Passt selbst deren Zusammenfassungsanfrage nicht mehr, erkennt Loop Mode den resultierenden `length`-/Kontextfehler und erstellt eine begrenzte, LLM-unabhängige Notfall-Zusammenfassung. Ein Circuit-Breaker pausiert nach wiederholt gescheiterter Recovery, statt den Kontext durch endlose Retries weiter zu vergrößern. Die Langzeit-Orientierung gehört trotzdem in `GOAL.md`, `PROGRESS.md` und die git-Historie.

**Was, wenn das Check-Script selbst kaputt ist?**
Warnung im UI, der Loop läuft ungestört weiter (der Check blockiert nie). `/loop resume --check "korrigiertes CMD"` setzt ein neues Check-Kommando.

**Funktioniert das mit lokalen Modellen (Ollama/vLLM)?**
Ja — der Loop ist modellunabhängig und gerade für schwächere Modelle gehärtet (Wiederholungs- und Degenerations­erkennung, Sampling-Penalties, Rescue-Modell, Auto-Compaction, Fertig-Verifikation per Check, Fehler-Retry). Empfehlung für kleine Modelle: konkreteres Ziel, `--check` immer, `--rescue-model <starkes Modell>` setzen, ggf. `--max` für den Erstlauf.

**Das Modell wiederholt ständig denselben Satz, dasselbe Wort oder eine kurze Phrase — was tun?**
Nichts — genau dafür gibt es mehrere Verteidigungslinien: Near-Duplicate-Erkennung fängt Umformulierungen, während der Degenerations-Kill-Switch Satzschleifen, Einzelwortläufe (16×) und kurze Phrasenläufe (8×) mid-stream abbricht und aus dem Kontext schneidet. Die automatische Stuck-Recovery setzt den Loop fort; Sampling-Penalties, Rescue-Modell und Auto-Compaction eskalieren bei Bedarf weiter. Wenn es trotzdem häufig passiert: `/loop stats` prüfen — viele `stuck`/`compact`-Events deuten auf ein zu schwaches Modell oder ein zu vages Ziel.

**Wie stoppe ich alles und fange neu an?**
`/loop end` löscht den Zustand vollständig. `/loop start <neues Ziel>` ersetzt den Loop ebenfalls komplett.
