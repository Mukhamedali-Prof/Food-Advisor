-- Safe to apply repeatedly; these columns are used by restaurant creation and detail pages.
ALTER TABLE restaurants
    ADD COLUMN IF NOT EXISTS description TEXT NULL AFTER address,
    ADD COLUMN IF NOT EXISTS image VARCHAR(255) NULL AFTER description;
