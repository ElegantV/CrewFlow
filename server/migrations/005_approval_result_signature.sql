ALTER TABLE users
  ADD COLUMN signature_data bytea,
  ADD COLUMN signature_mime_type varchar(30),
  ADD COLUMN signature_updated_at timestamptz,
  ADD CONSTRAINT users_signature_pair_check CHECK (
    (signature_data IS NULL AND signature_mime_type IS NULL)
    OR (signature_data IS NOT NULL AND signature_mime_type IN ('image/png', 'image/jpeg'))
  );

ALTER TABLE timeoff_allocations
  ADD COLUMN remaining_before numeric(5,2),
  ADD COLUMN remaining_after numeric(5,2);

UPDATE timeoff_allocations allocation
SET remaining_before = duty.remaining_hours + allocation.hours,
    remaining_after = duty.remaining_hours
FROM duty_records duty
WHERE duty.id = allocation.duty_record_id;

ALTER TABLE timeoff_allocations
  ALTER COLUMN remaining_before SET NOT NULL,
  ALTER COLUMN remaining_after SET NOT NULL,
  ADD CONSTRAINT timeoff_allocation_balance_check CHECK (
    remaining_before >= hours
    AND remaining_after = remaining_before - hours
    AND remaining_after >= 0
  );

ALTER TABLE approval_records
  ADD COLUMN result_snapshot jsonb,
  ADD COLUMN signer_name varchar(80),
  ADD COLUMN signature_data bytea,
  ADD COLUMN signature_mime_type varchar(30),
  ADD CONSTRAINT approval_signature_pair_check CHECK (
    (signature_data IS NULL AND signature_mime_type IS NULL)
    OR (signature_data IS NOT NULL AND signature_mime_type IN ('image/png', 'image/jpeg'))
  );
