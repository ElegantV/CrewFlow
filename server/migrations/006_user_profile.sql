ALTER TABLE users
  ADD COLUMN account_name varchar(64),
  ADD COLUMN oa_account varchar(64),
  ADD COLUMN id_card_no varchar(18),
  ADD COLUMN avatar_data bytea,
  ADD COLUMN avatar_mime_type varchar(30),
  ADD COLUMN personnel_type varchar(20) NOT NULL DEFAULT 'vendor'
    CHECK (personnel_type IN ('bank', 'digital', 'vendor')),
  ADD COLUMN digital_employee_no varchar(64),
  ADD COLUMN department varchar(120),
  ADD COLUMN bank_project varchar(160),
  ADD COLUMN attendance_location varchar(160),
  ADD COLUMN bank_level varchar(80),
  ADD COLUMN itl_status varchar(20) NOT NULL DEFAULT 'no'
    CHECK (itl_status IN ('yes', 'no', 'ops')),
  ADD COLUMN work_start_date date,
  ADD COLUMN mobile varchar(30),
  ADD COLUMN address varchar(300),
  ADD COLUMN emergency_contact_name varchar(80),
  ADD COLUMN emergency_contact_phone varchar(30),
  ADD CONSTRAINT users_avatar_pair_check CHECK (
    (avatar_data IS NULL AND avatar_mime_type IS NULL)
    OR (avatar_data IS NOT NULL AND avatar_mime_type IS NOT NULL)
  );

CREATE UNIQUE INDEX users_account_name_unique_idx
  ON users (lower(account_name)) WHERE account_name IS NOT NULL;
CREATE UNIQUE INDEX users_oa_account_unique_idx
  ON users (lower(oa_account)) WHERE oa_account IS NOT NULL;
CREATE UNIQUE INDEX users_id_card_no_unique_idx
  ON users (id_card_no) WHERE id_card_no IS NOT NULL;
