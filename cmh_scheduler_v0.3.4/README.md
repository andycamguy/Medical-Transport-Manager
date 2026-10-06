# CMH Scheduler v0.4.0

Flask + SQLAlchemy + PostgreSQL + Flask-Login application for CMH Medical Transportation.

## Local Windows test

```powershell
py -m venv .venv
.venv\Scripts\activate
py -m pip install -r requirements.txt
$env:COOKIE_SECURE="0"
$env:SEED_DEMO_DATA="1"
py app.py
```

If `DATABASE_URL` is not set, local development uses the existing SQLite file. Local demo owner: `ben` / `CMHdemo123!`. Change it from ACCOUNT before any real use.

## Production

Recommended: Render web service + managed Render PostgreSQL. The included `render.yaml` uses paid plans rather than Render's free database/web limitations. Set `ADMIN_USERNAME` and `ADMIN_PASSWORD` as secret environment variables. Production uses `SEED_DEMO_DATA=0`, so fictional demo patients are not created.

The first production startup creates the configured owner account. Change the initial password immediately after logging in.

## Security included

- PostgreSQL-ready SQLAlchemy configuration
- HTTPS-only secure cookies in production
- CSRF protection for forms and JSON state/reset APIs
- HTTP security headers
- Login rate limiting
- Password hashing with Werkzeug
- Owner-only demo reset
- Production fails closed if SECRET_KEY or ADMIN_PASSWORD is missing
- Health check that verifies the database connection

## Important

This is not a claim of HIPAA compliance. Before entering real PHI, CMH should complete its required security/compliance review, including authorization, audit logging, backups/recovery testing, vendor agreements where applicable, and operational policies. Never commit credentials or real patient data to Git.
