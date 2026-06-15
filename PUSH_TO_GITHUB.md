# Pushing Financier to GitHub (private)

You'll do these steps on your own machine — the code never passes through anyone
else's hands, and your real data stays local.

## 0. One-time check before you start

Make sure you're NOT inside `~/asset-tracker` or `~/asset-tracker-ui` when you do
this — you'll be working from the new `financier/` folder you downloaded.

Also: confirm your real `tracker.db` is NOT inside this `financier/` folder. It
shouldn't be — your data lives at `~/asset-tracker/tracker.db`, separate from the
code. The `.gitignore` would catch it anyway, but check.

## 1. Create the repo on GitHub

1. Go to https://github.com/new
2. Repository name: `financier`
3. Set it to **Private**
4. Do NOT tick "Add a README" / .gitignore / license (we already have them)
5. Click **Create repository**

GitHub will show you the repo URL, e.g. `https://github.com/YOURNAME/financier.git`

## 2. Initialise git locally and push

Open a terminal, `cd` into the `financier/` folder you downloaded, then:

```bash
git init
git add .
git commit -m "Initial commit: Financier v2"
git branch -M main
git remote add origin https://github.com/YOURNAME/financier.git
git push -u origin main
```

(Replace `YOURNAME` with your actual GitHub username.)

If git asks you to log in, follow the prompt — on a Mac it usually opens a browser
to authenticate, or asks for a Personal Access Token instead of a password.

## 3. Verify nothing sensitive got uploaded

After pushing, open the repo on GitHub and confirm:

- ✅ You see `server/`, `web/`, `README.md`, `.gitignore`
- ❌ You do NOT see any `.db` file
- ❌ You do NOT see any `.env` file (only `.env.example` is fine)
- ❌ You do NOT see any `financier-backup-*.json`

If any of those slipped in, tell me — we'll fix it before it matters.

## Later: making changes

Once it's up, your normal workflow is:

```bash
git add .
git commit -m "describe what changed"
git push
```

## Later: when you want to use it as a portfolio piece

Repo Settings → General → scroll to "Danger Zone" → Change visibility → Public.
One click, reversible.
