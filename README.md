# pi-skills-extensions

Public Pi package: engineering skills (and room for extensions, prompts, themes). Install once globally with the Pi CLI; Pi discovers `extensions/`, `skills/`, `prompts/`, and `themes/` from the installed package.

## Structure

```
extensions/   ← .ts extension files
skills/       ← skill dirs (each needs a SKILL.md)
prompts/      ← .md prompt templates
themes/       ← .json themes
```

## Install (global)

```bash
pi install https://github.com/NicoPowers/pi-skills-extensions
```

Optional: pin a release or commit:

```bash
pi install https://github.com/NicoPowers/pi-skills-extensions@v1.0.0
```

Equivalent Git source form:

```bash
pi install git:github.com/NicoPowers/pi-skills-extensions
```

Project-local install (package under `.pi/git/` in the repo you run Pi from):

```bash
pi install https://github.com/NicoPowers/pi-skills-extensions -l
```

After install, use `pi list` and `pi config` to confirm or toggle package resources.

## Usage

```bash
pi            # extensions + skills load per your Pi config
/reload       # pick up changes without restarting
```

## Updates

```bash
pi update https://github.com/NicoPowers/pi-skills-extensions
```

Or `pi update` to refresh Pi and all non-pinned packages.
