ALTER TABLE leave_requests
  DROP COLUMN IF EXISTS proof_file_key,
  DROP COLUMN IF EXISTS proof_file_name;
