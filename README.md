# Question Bank Review GUI

Run from this directory:

```bash
npm start
```

The server uses `/workspace/memory/question_bank.sqlite3` by default and listens on port `4173`. Override these with `QUESTION_BANK_DB` and `PORT`.

Edits are transactionally saved to the existing question records and appended to revision history. Explicit batch approval requires all questions to be confirmed, a clean QA run, and the full confirmation phrase shown in the approval dialog.

Create a self-contained offline reviewer with embedded data and source PDFs:

```bash
npm run build:offline
```

The offline version stores edits in the browser's local storage. Export JSON from the interface to transfer corrections back into the persistent database workflow.

## Desktop application

The Electron desktop shell owns its application data and starts the question-bank service on a private random loopback port. Users never need to open a `localhost` address. On first launch it seeds the database and source PDFs, creates rolling database backups, and opens the review workspace in its own window.

Development commands after installing dependencies:

```bash
npm run desktop
npm run worker:build
npm run make
```

The Windows build workflow under `.github/workflows/` creates the packaged Python PDF worker and the Electron installer. The current worker validates and stages arbitrary question and answer files offline. General question segmentation for new imports is the next processing module; review, corrections, QA, revision history, approval, and export are already implemented.
