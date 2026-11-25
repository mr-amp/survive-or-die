import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import {
  CREATE_TABLES,
  MIGRATION_V9,
  MIGRATION_V9_ALTER_CHILDREN_ROLE,
  MIGRATION_V10,
  MIGRATION_V12,
  MIGRATION_V13,
  MIGRATION_V14,
  MIGRATION_V15,
  MIGRATION_V16,
  MIGRATION_V17,
  MIGRATION_V18,
  MIGRATION_V19,
  MIGRATION_V20,
  MIGRATION_V21,
  MIGRATION_V22,
  MIGRATION_V23,
  MIGRATION_V24,
} from "../../state/schema.js";

export type TestDatabase = BetterSqlite3.Database;

export function createInMemoryDb(): TestDatabase {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(CREATE_TABLES);
  db.exec(MIGRATION_V9);
  try { db.exec(MIGRATION_V9_ALTER_CHILDREN_ROLE); } catch { /* column may already exist */ }
  db.exec(MIGRATION_V10);
  db.exec(MIGRATION_V12);
  db.exec(MIGRATION_V13);
  db.exec(MIGRATION_V14);
  db.exec(MIGRATION_V15);
  db.exec(MIGRATION_V16);
  db.exec(MIGRATION_V17);
  db.exec(MIGRATION_V18);
  db.exec(MIGRATION_V19);
  db.exec(MIGRATION_V20);
  db.exec(MIGRATION_V21);
  db.exec(MIGRATION_V22);
  db.exec(MIGRATION_V23);
  db.exec(MIGRATION_V24);
  return db;
}
