const {
  DatabaseSync
} = require("node:sqlite");

const {
  mkdirSync
} = require("node:fs");

const {
  dirname
} = require("node:path");

const {
  AppError
} = require("./errors");

// Agrega la propiedad lowStock a un material.
function view(row) {
  return {
    ...row,
    lowStock: row.quantity <= row.minimum
  };
}

// Convierte un error de duplicado en un mensaje comprensible.
function duplicate(error) {
  if (error.message.includes("UNIQUE constraint")) {
    throw new AppError("El material ya existe, incluso si fue eliminado. Usa otro nombre.", 409);
  }

  throw error;
}

function createStore(filename = ":memory:") {
  // Si se usará un archivo, crea su carpeta.
  if (filename !== ":memory:") {
    mkdirSync(dirname(filename), {
      recursive: true
    });
  }

  // Abre la base de datos o la crea si no existe.
  const db = new DatabaseSync(filename);

  // Crea las tablas vacías.
  db.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL
        CHECK(role IN ('administrador', 'usuario'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      last_seen INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS products (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL COLLATE NOCASE UNIQUE,
      unit TEXT NOT NULL,
      quantity INTEGER NOT NULL
        CHECK(quantity >= 0 AND quantity <= 1000000),
      minimum INTEGER NOT NULL
        CHECK(minimum >= 0 AND minimum <= 1000000)
    );

    CREATE TABLE IF NOT EXISTS movements (
      id INTEGER PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      type TEXT NOT NULL
        CHECK(type IN ('entrada', 'consumo')),
      quantity INTEGER NOT NULL CHECK(quantity > 0),
      note TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  // Actualiza bases existentes sin perder materiales ni movimientos.
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!db.prepare("PRAGMA table_info(products)").all().some(column => column.name === "deleted_at")) {
      db.exec("ALTER TABLE products ADD COLUMN deleted_at TEXT");
      db.exec("ALTER TABLE products ADD COLUMN deleted_by INTEGER REFERENCES users(id)");
    }
    const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name = 'movements'").get().sql;
    if (!schema.includes("'salida'")) {
      db.exec(`
        CREATE TABLE movements_updated (
          id INTEGER PRIMARY KEY,
          product_id INTEGER NOT NULL REFERENCES products(id),
          user_id INTEGER NOT NULL REFERENCES users(id),
          type TEXT NOT NULL CHECK(type IN ('entrada', 'consumo', 'salida')),
          quantity INTEGER NOT NULL CHECK(quantity > 0),
          note TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        INSERT INTO movements_updated SELECT * FROM movements;
        DROP TABLE movements;
        ALTER TABLE movements_updated RENAME TO movements;
      `);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.close();
    throw error;
  }

  // Busca un material por su identificador.
  function getProduct(id) {
    const row = db.prepare(`
      SELECT * FROM products WHERE id = ? AND deleted_at IS NULL
    `).get(id);

    if (!row) {
      throw new AppError("Material no encontrado.", 404);
    }

    return view(row);
  }

  // Cierra la conexión con SQLite.
  function close() {
    return db.close();
  }

  // Agrega un usuario con un rol específico.
  // Se utilizará principalmente en las pruebas.
  function addUser(email, hash, role) {
    const result = db.prepare(`
      INSERT INTO users(email, password_hash, role)
      VALUES(?, ?, ?)
    `).run(email, hash, role);

    return Number(result.lastInsertRowid);
  }

  // Registra una cuenta.
  // La primera será administradora y las siguientes serán usuarias.
  function registerUser(email, hash) {
    db.exec("BEGIN IMMEDIATE");

    try {
      const existingUser = db.prepare(`
        SELECT id FROM users LIMIT 1
      `).get();

      let role = "usuario";

      if (!existingUser) {
        role = "administrador";
      }

      const result = db.prepare(`
        INSERT INTO users(email, password_hash, role)
        VALUES(?, ?, ?)
      `).run(email, hash, role);

      const id = Number(result.lastInsertRowid);

      db.exec("COMMIT");

      return {
        id,
        email,
        role
      };
    } catch (error) {
      db.exec("ROLLBACK");

      if (error.message.includes("UNIQUE constraint")) {
        throw new AppError(
          "Este correo ya está registrado.",
          409
        );
      }

      throw error;
    }
  }

  // Busca una cuenta mediante su correo.
  function findUser(email) {
    return db.prepare(`
      SELECT * FROM users WHERE email = ?
    `).get(email);
  }

  // Crea una sesión.
  function newSession(sessionId, userId, now) {
    return db.prepare(`
      INSERT INTO sessions(id, user_id, last_seen)
      VALUES(?, ?, ?)
    `).run(sessionId, userId, now);
  }

  // Busca una sesión y obtiene los datos de su usuario.
  function session(sessionId) {
    return db.prepare(`
      SELECT
        sessions.*,
        users.email,
        users.role
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.id = ?
    `).get(sessionId);
  }

  // Actualiza la última actividad de una sesión.
  function touchSession(sessionId, now) {
    return db.prepare(`
      UPDATE sessions
      SET last_seen = ?
      WHERE id = ?
    `).run(now, sessionId);
  }

  // Elimina una sesión al cerrar sesión.
  function deleteSession(sessionId) {
    return db.prepare(`
      DELETE FROM sessions
      WHERE id = ?
    `).run(sessionId);
  }

  // Devuelve todos los materiales ordenados por nombre.
  function listProducts() {
    return db.prepare(`
      SELECT * FROM products
      WHERE deleted_at IS NULL
      ORDER BY name
    `).all().map(view);
  }

  // Registra un material y su existencia inicial.
  function addProduct(data, quantity, userId) {
    db.exec("BEGIN IMMEDIATE");

    try {
      const result = db.prepare(`
        INSERT INTO products(name, unit, quantity, minimum)
        VALUES(?, ?, ?, ?)
      `).run(
        data.name,
        data.unit,
        quantity,
        data.minimum
      );

      const productId = Number(result.lastInsertRowid);

      if (quantity > 0) {
        db.prepare(`
          INSERT INTO movements(
            product_id,
            user_id,
            type,
            quantity,
            note,
            created_at
          )
          VALUES(?, ?, ?, ?, ?, ?)
        `).run(
          productId,
          userId,
          "entrada",
          quantity,
          "Existencia inicial",
          new Date().toISOString()
        );
      }

      db.exec("COMMIT");

      return getProduct(productId);
    } catch (error) {
      db.exec("ROLLBACK");
      duplicate(error);
    }
  }

  // Modifica el nombre, unidad y existencia mínima.
  function updateProduct(productId, data) {
    getProduct(productId);

    try {
      db.prepare(`
        UPDATE products
        SET name = ?, unit = ?, minimum = ?
        WHERE id = ?
      `).run(
        data.name,
        data.unit,
        data.minimum,
        productId
      );

      return getProduct(productId);
    } catch (error) {
      duplicate(error);
    }
  }

  // Retira el material del inventario y conserva su historial.
  function deleteProduct(productId, userId) {
    getProduct(productId);
    db.prepare(`
      UPDATE products SET deleted_at = ?, deleted_by = ? WHERE id = ?
    `).run(new Date().toISOString(), userId, productId);
  }

  // Registra una entrada, consumo o salida por defecto u otra causa.
  function move(
    productId,
    userId,
    type,
    amount,
    note
  ) {
    db.exec("BEGIN IMMEDIATE");

    try {
      const current = getProduct(productId);
      let nextQuantity;

      if (type === "entrada") {
        nextQuantity = current.quantity + amount;
      } else {
        nextQuantity = current.quantity - amount;
      }

      if (nextQuantity < 0) {
        throw new AppError(
          "No hay existencias suficientes.",
          409
        );
      }

      if (nextQuantity > 1000000) {
        throw new AppError(
          "La existencia excedería el máximo permitido."
        );
      }

      db.prepare(`
        UPDATE products
        SET quantity = ?
        WHERE id = ?
      `).run(nextQuantity, productId);

      db.prepare(`
        INSERT INTO movements(
          product_id,
          user_id,
          type,
          quantity,
          note,
          created_at
        )
        VALUES(?, ?, ?, ?, ?, ?)
      `).run(
        productId,
        userId,
        type,
        amount,
        note,
        new Date().toISOString()
      );

      db.exec("COMMIT");

      return getProduct(productId);
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  // Devuelve los últimos movimientos.
  function movements() {
    return db.prepare(`
      SELECT
        movements.*,
        products.name,
        products.deleted_at,
        users.email
      FROM movements
      JOIN products
        ON products.id = movements.product_id
      JOIN users
        ON users.id = movements.user_id
      ORDER BY movements.id DESC
      LIMIT 200
    `).all();
  }

  // Expone las funciones que utilizarán los demás archivos.
  return {
    db,
    close,
    addUser,
    registerUser,
    findUser,
    newSession,
    session,
    touchSession,
    deleteSession,
    listProducts,
    getProduct,
    addProduct,
    updateProduct,
    deleteProduct,
    move,
    movements
  };
}

module.exports = {
  createStore
};
