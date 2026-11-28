-- Formulaire de contact : rôle « distributeur ou intégrateur ».
ALTER TABLE contact_requests DROP CONSTRAINT IF EXISTS contact_requests_role_check;
ALTER TABLE contact_requests ADD CONSTRAINT contact_requests_role_check CHECK (role IN ('software', 'reseller', 'psp', 'other'));
