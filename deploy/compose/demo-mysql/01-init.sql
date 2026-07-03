-- デモ用 MySQL スキーマ。compose の demo-mysql 起動時に投入される。
CREATE TABLE IF NOT EXISTS demo_items (
  id INT PRIMARY KEY,
  name VARCHAR(50) NOT NULL
);

INSERT INTO demo_items (id, name) VALUES
  (1, 'alpha'),
  (2, 'beta'),
  (3, 'gamma');
