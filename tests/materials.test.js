const request = require("supertest");
const { createStore } = require("../src/store");
const { createApp } = require("../src/app");
const { hashPassword } = require("../src/auth");
const { DatabaseSync } = require("node:sqlite");
const { mkdtempSync, rmSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");

describe("Eliminación y salidas administrativas", () => {
  let store, app, admin, user, product;
  beforeEach(async () => {
    store = createStore();
    const hash = hashPassword("Prueba2026!");
    const adminId = store.addUser("admin@test.com", hash, "administrador");
    store.addUser("user@test.com", hash, "usuario");
    app = createApp({ store, secret: "s".repeat(48) });
    admin = (await request(app).post("/api/login").send({ email: "admin@test.com", password: "Prueba2026!" })).body.token;
    user = (await request(app).post("/api/login").send({ email: "user@test.com", password: "Prueba2026!" })).body.token;
    product = store.addProduct({ name: "Barniz", unit: "frascos", minimum: 3 }, 5, adminId);
  });
  afterEach(() => store.close());
  const authorize = (operation, token) => operation.set("Authorization", `Bearer ${token}`);

  test("cinco recibidos menos dos defectuosos dejan tres y conservan motivo y responsable", async () => {
    const result = await authorize(request(app).post(`/api/products/${product.id}/movements`), admin)
      .send({ type: "salida", quantity: 2, note: "Llegaron defectuosos" });
    expect(result.status).toBe(201);
    expect(result.body).toMatchObject({ quantity: 3, lowStock: true });
    expect(store.movements()).toHaveLength(2);
    expect(store.movements()[0]).toMatchObject({ type: "salida", quantity: 2, note: "Llegaron defectuosos", email: "admin@test.com" });
  });

  test.each([null, "usuario"])("bloquea ambas operaciones para %s sin modificar datos", async role => {
    let deletion = request(app).delete(`/api/products/${product.id}`);
    let exit = request(app).post(`/api/products/${product.id}/movements`);
    if (role) {
      deletion = authorize(deletion, user);
      exit = authorize(exit, user);
    }
    expect((await deletion).status).toBe(role ? 403 : 401);
    expect((await exit.send({ type: "salida", quantity: 2, note: "Defectuoso" })).status).toBe(role ? 403 : 401);
    expect(store.getProduct(product.id).quantity).toBe(5);
    expect(store.movements()).toHaveLength(1);
  });

  test.each([[0, "Defecto", 400], [-1, "Defecto", 400], [1.5, "Defecto", 400], [2, " ", 400], [6, "Defecto", 409]])(
    "rechaza salida inválida %s %s", async (quantity, note, status) => {
      const result = await authorize(request(app).post(`/api/products/${product.id}/movements`), admin)
        .send({ type: "salida", quantity, note });
      expect(result.status).toBe(status);
      expect(store.getProduct(product.id).quantity).toBe(5);
      expect(store.movements()).toHaveLength(1);
    }
  );

  test("eliminar oculta el material, preserva historial y bloquea operaciones posteriores", async () => {
    expect((await authorize(request(app).delete(`/api/products/${product.id}`), admin)).status).toBe(204);
    expect(store.listProducts()).toEqual([]);
    expect(store.movements()[0]).toMatchObject({ name: "Barniz", quantity: 5, deleted_at: expect.any(String) });
    expect((await authorize(request(app).delete(`/api/products/${product.id}`), admin)).status).toBe(404);
    expect((await authorize(request(app).put(`/api/products/${product.id}`), admin)
      .send({ name: "Otro", unit: "frascos", minimum: 0 })).status).toBe(404);
    for (const type of ["entrada", "consumo", "salida"]) {
      expect((await authorize(request(app).post(`/api/products/${product.id}/movements`), admin)
        .send({ type, quantity: 1, note: "Prueba" })).status).toBe(404);
    }
    expect(store.movements()).toHaveLength(1);
  });

  test("un fallo al guardar la salida revierte el descuento", async () => {
    store.db.exec("CREATE TRIGGER fail BEFORE INSERT ON movements BEGIN SELECT RAISE(ABORT, 'fail'); END;");
    const result = await authorize(request(app).post(`/api/products/${product.id}/movements`), admin)
      .send({ type: "salida", quantity: 2, note: "Defecto" });
    expect(result.status).toBe(500);
    expect(store.getProduct(product.id).quantity).toBe(5);
    expect(store.movements()).toHaveLength(1);
  });
});

test("migra una base anterior y conserva datos después de reabrir", () => {
  const directory = mkdtempSync(join(tmpdir(), "nailflow-migration-"));
  const filename = join(directory, "test.sqlite");
  let store;
  try {
    const old = new DatabaseSync(filename);
    old.exec(`
      CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, password_hash TEXT, role TEXT);
      CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT UNIQUE, unit TEXT, quantity INTEGER, minimum INTEGER);
      CREATE TABLE movements (id INTEGER PRIMARY KEY, product_id INTEGER REFERENCES products(id), user_id INTEGER REFERENCES users(id), type TEXT CHECK(type IN ('entrada', 'consumo')), quantity INTEGER, note TEXT, created_at TEXT);
      INSERT INTO users VALUES (1, 'admin@test.com', 'hash', 'administrador');
      INSERT INTO products VALUES (1, 'Barniz', 'frascos', 5, 0);
      INSERT INTO movements VALUES (1, 1, 1, 'entrada', 5, 'Compra', '2026-09-21');
    `);
    old.close();
    store = createStore(filename);
    expect(store.movements()[0]).toMatchObject({ id: 1, quantity: 5, note: "Compra" });
    store.move(1, 1, "salida", 2, "Defectuosos");
    expect(store.getProduct(1).quantity).toBe(3);
    store.deleteProduct(1, 1);
    store.close();
    store = null;
    store = createStore(filename);
    expect(store.listProducts()).toEqual([]);
    expect(store.movements()).toHaveLength(2);
    expect(store.db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    if (store) store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
