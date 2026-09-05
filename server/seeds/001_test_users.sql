BEGIN;

INSERT INTO users (openid, name, employee_no, role, status)
VALUES
  ('crewflow-test-admin-001', '测试管理员甲', 'TEST-A001', 'admin', 'active'),
  ('crewflow-test-admin-002', '测试管理员乙', 'TEST-A002', 'admin', 'active'),
  ('crewflow-test-user-001', '测试用户张三', 'TEST-U001', 'user', 'active'),
  ('crewflow-test-user-002', '测试用户李四', 'TEST-U002', 'user', 'active'),
  ('crewflow-test-user-003', '测试用户王五', 'TEST-U003', 'user', 'active'),
  ('crewflow-test-user-004', '测试用户赵六', 'TEST-U004', 'user', 'active')
ON CONFLICT (openid) DO UPDATE SET
  name = EXCLUDED.name,
  employee_no = EXCLUDED.employee_no,
  role = EXCLUDED.role,
  status = EXCLUDED.status,
  updated_at = now();

UPDATE users AS target
SET manager_id = manager.id,
    agent_user_id = agent.id,
    updated_at = now()
FROM users AS manager, users AS agent
WHERE target.openid = 'crewflow-test-user-001'
  AND manager.openid = 'crewflow-test-admin-001'
  AND agent.openid = 'crewflow-test-user-002';

UPDATE users AS target
SET manager_id = manager.id,
    agent_user_id = agent.id,
    updated_at = now()
FROM users AS manager, users AS agent
WHERE target.openid = 'crewflow-test-user-002'
  AND manager.openid = 'crewflow-test-admin-001'
  AND agent.openid = 'crewflow-test-user-001';

UPDATE users AS target
SET manager_id = manager.id,
    agent_user_id = agent.id,
    updated_at = now()
FROM users AS manager, users AS agent
WHERE target.openid = 'crewflow-test-user-003'
  AND manager.openid = 'crewflow-test-admin-002'
  AND agent.openid = 'crewflow-test-user-004';

UPDATE users AS target
SET manager_id = manager.id,
    agent_user_id = agent.id,
    updated_at = now()
FROM users AS manager, users AS agent
WHERE target.openid = 'crewflow-test-user-004'
  AND manager.openid = 'crewflow-test-admin-002'
  AND agent.openid = 'crewflow-test-user-003';

COMMIT;

