# my-pi-skills-extensions

Personal pi extensions and skills — loaded globally via `~/.pi/agent/settings.json`.

## Structure

```
extensions/   ← .ts extension files
skills/       ← skill dirs (each needs a SKILL.md)
prompts/      ← .md prompt templates
themes/       ← .json themes
```

## Global setup (already done)

`~/.pi/agent/settings.json` has:
```json
{
  "packages": ["C:/Users/nicol/OneDrive/Documents/Projects/my-pi-skills-extensions"]
}
```

Pi auto-discovers everything in `extensions/`, `skills/`, `prompts/`, and `themes/` from any directory.

## Usage

```bash
pi            # extensions + skills load automatically
/reload       # pick up any new files without restarting
```
