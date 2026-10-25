# billing

Invoices and customers. Migrations in `db/migrations` run in filename order on deploy, while the
old and new app versions are both live, so every migration must be backward compatible.
