-- デモ用 PostgreSQL スキーマ。compose の demo-postgres 起動時に投入される。
CREATE TABLE IF NOT EXISTS demo_items (
  id INT PRIMARY KEY,
  name TEXT NOT NULL
);

INSERT INTO demo_items (id, name) VALUES
  (1, 'alpha'),
  (2, 'beta'),
  (3, 'gamma');
