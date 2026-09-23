const request = require("supertest");
const jwt = require("jsonwebtoken");

const {
  createApp
} = require("../src/app");

const {
  createStore
} = require("../src/store");

const {
  hashPassword
} = require("../src/auth");

const {
  randomBytes
} = require("node:crypto");


describe("Registro de cuentas desde una base vacía", () => {
  let store;
  let app;
  let secret;

  const account = {
    email: "PRIMERA@REGISTRO.TEST",
    password: "Registro2026!"
  };

  beforeEach(() => {
    store = createStore();
    secret = randomBytes(48).toString("hex");

    app = createApp({
      store,
      secret,
      loginLimit: 100
    });
  });

  afterEach(() => {
    store.close();
  });

  test("arranca sin cuentas ni materiales", async () => {
    const users = store.db.prepare(`
      SELECT COUNT(*) AS n FROM users
    `).get();

    expect(users.n).toBe(0);
    expect(store.listProducts()).toHaveLength(0);

    const login = await request(app)
      .post("/api/login")
      .send(account);

    expect(login.status).toBe(401);
  });

  test(
    "la primera cuenta recibe administración sin revelar el hash",
    async () => {
      const response = await request(app)
        .post("/api/register")
        .send({
          ...account,
          role: "usuario"
        });

      expect(response.status).toBe(201);

      expect(response.body.user).toEqual({
        id: 1,
        email: "primera@registro.test",
        role: "administrador"
      });

      expect(
        response.body.user.password_hash
      ).toBeUndefined();

      expect(
        store.findUser(
          "primera@registro.test"
        ).password_hash
      ).not.toContain(account.password);

      const me = await request(app)
        .get("/api/me")
        .set(
          "Authorization",
          `Bearer ${response.body.token}`
        );

      expect(me.status).toBe(200);
      expect(me.body.role).toBe("administrador");
      expect(store.listProducts()).toHaveLength(0);
    }
  );

  test(
    "los siguientes registros no pueden elegir administración",
    async () => {
      await request(app)
        .post("/api/register")
        .send(account);

      const second = await request(app)
        .post("/api/register")
        .send({
          ...account,
          email: "segunda@registro.test",
          role: "administrador"
        });

      expect(second.status).toBe(201);
      expect(second.body.user.role).toBe("usuario");

      const blocked = await request(app)
        .post("/api/products")
        .set(
          "Authorization",
          `Bearer ${second.body.token}`
        )
        .send({
          name: "Prueba",
          unit: "piezas",
          minimum: 0,
          quantity: 1
        });

      expect(blocked.status).toBe(403);

      const login = await request(app)
        .post("/api/login")
        .send({
          ...account,
          email: "segunda@registro.test"
        });

      expect(login.status).toBe(200);
      expect(login.body.user.role).toBe("usuario");
    }
  );

  test(
    "dos registros simultáneos solo crean una administradora",
    async () => {
      const emails = [
        "uno@registro.test",
        "dos@registro.test"
      ];

      const results = await Promise.all(
        emails.map(email =>
          request(app)
            .post("/api/register")
            .send({
              ...account,
              email
            })
        )
      );

      expect(
        results.map(result => result.status)
      ).toEqual([201, 201]);

      expect(
        results
          .map(result => result.body.user.role)
          .sort()
      ).toEqual([
        "administrador",
        "usuario"
      ]);
    }
  );

  test(
    "rechaza duplicados sin cambiar contraseña ni rol",
    async () => {
      await request(app)
        .post("/api/register")
        .send(account);

      const hash = store.findUser(
        "primera@registro.test"
      ).password_hash;

      const duplicate = await request(app)
        .post("/api/register")
        .send({
          email: "primera@registro.test",
          password: "OtraRegistro2026!"
        });

      expect(duplicate.status).toBe(409);

      expect(
        duplicate.body.error
      ).toContain("ya está registrado");

      expect(
        store.findUser(
          "primera@registro.test"
        ).password_hash
      ).toBe(hash);

      const login = await request(app)
        .post("/api/login")
        .send(account);

      expect(login.status).toBe(200);

      const newAccount = await request(app)
        .post("/api/register")
        .send({
          ...account,
          email: "nueva@registro.test"
        });

      expect(
        newAccount.body.user.role
      ).toBe("usuario");
    }
  );

  test.each([
    {},
    {
      ...account,
      email: "<script>alert(1)</script>"
    },
    {
      ...account,
      password: ""
    }
  ])(
    "un registro inválido no ocupa la primera cuenta %p",
    async body => {
      const invalid = await request(app)
        .post("/api/register")
        .send(body);

      expect(invalid.status).toBe(400);

      const users = store.db.prepare(`
        SELECT COUNT(*) AS n FROM users
      `).get();

      expect(users.n).toBe(0);

      const valid = await request(app)
        .post("/api/register")
        .send(account);

      expect(
        valid.body.user.role
      ).toBe("administrador");
    }
  );

  test(
    "limita intentos de registro repetidos",
    async () => {
      const limited = createApp({
        store,
        secret,
        loginLimit: 2
      });

      for (let i = 0; i < 2; i++) {
        await request(limited)
          .post("/api/register")
          .send({});
      }

      const response = await request(limited)
        .post("/api/register")
        .send(account);

      expect(response.status).toBe(429);

      const users = store.db.prepare(`
        SELECT COUNT(*) AS n FROM users
      `).get();

      expect(users.n).toBe(0);
    }
  );

  test(
    "un error de almacenamiento no deja una cuenta parcial",
    async () => {
      store.db.exec(`
        CREATE TRIGGER rechazar
        BEFORE INSERT ON users
        BEGIN
          SELECT RAISE(ABORT, 'rechazado');
        END;
      `);

      const failed = await request(app)
        .post("/api/register")
        .send(account);

      expect(failed.status).toBe(500);

      const users = store.db.prepare(`
        SELECT COUNT(*) AS n FROM users
      `).get();

      expect(users.n).toBe(0);

      store.db.exec(`
        DROP TRIGGER rechazar
      `);

      const valid = await request(app)
        .post("/api/register")
        .send(account);

      expect(
        valid.body.user.role
      ).toBe("administrador");
    }
  );
});


describe("Integración de API y controles de seguridad", () => {
  let store;
  let app;
  let secret;
  let admin;
  let user;
  let now;

  const product = {
    name: "Esmalte rosa",
    unit: "frascos",
    quantity: 10,
    minimum: 3
  };

  beforeEach(async () => {
    store = createStore();
    secret = randomBytes(48).toString("hex");
    now = Date.now();

    store.addUser(
      "admin@nailflow.test",
      hashPassword("ExampleAdmin2026!"),
      "administrador"
    );

    store.addUser(
      "user@nailflow.test",
      hashPassword("ExampleUser2026!"),
      "usuario"
    );

    app = createApp({
      store,
      secret,
      clock: () => now,
      loginLimit: 100
    });

    const adminLogin = await request(app)
      .post("/api/login")
      .send({
        email: "admin@nailflow.test",
        password: "ExampleAdmin2026!"
      });

    admin = adminLogin.body.token;

    const userLogin = await request(app)
      .post("/api/login")
      .send({
        email: "user@nailflow.test",
        password: "ExampleUser2026!"
      });

    user = userLogin.body.token;
  });

  afterEach(() => {
    store.close();
  });

  function withToken(
    selectedApp,
    token,
    method,
    path
  ) {
    return request(selectedApp)[method](path)
      .set(
        "Authorization",
        `Bearer ${token}`
      );
  }

  test(
    "salud y página principal disponibles sin sesión",
    async () => {
      const health = await request(app)
        .get("/api/health");

      expect(health.body.status).toBe("ok");

      const page = await request(app).get("/");

      expect(page.status).toBe(200);
      expect(page.text).toContain("NailFlow");

      expect(
        page.headers["content-security-policy"]
      ).toContain("script-src 'self'");

      expect(
        page.headers["x-content-type-options"]
      ).toBe("nosniff");

      expect(
        page.headers["x-powered-by"]
      ).toBeUndefined();

      const missing = await request(app)
        .get("/no-existe");

      expect(missing.status).toBe(404);
    }
  );

  test(
    "consulta identidad sin exponer contraseña o hash",
    async () => {
      const response = await withToken(
        app,
        admin,
        "get",
        "/api/me"
      );

      expect(
        response.body.role
      ).toBe("administrador");

      expect(
        response.body.password_hash
      ).toBeUndefined();

      expect(
        response.headers["cache-control"]
      ).toBe("no-store");
    }
  );

  test.each([
    null,
    "Basic abc",
    "Bearer inválido"
  ])(
    "bloquea autenticación inválida %p",
    async header => {
      let operation = request(app)
        .get("/api/products");

      if (header) {
        operation = operation.set(
          "Authorization",
          header
        );
      }

      const response = await operation;

      expect(response.status).toBe(401);
    }
  );

  test.each([
    "ExampleIncorrect2026!",
    "ExampleUser2026!"
  ])(
    "no acepta contraseña incorrecta %p",
    async password => {
      const response = await request(app)
        .post("/api/login")
        .send({
          email: "admin@nailflow.test",
          password
        });

      expect(response.status).toBe(401);
    }
  );

  test(
    "correo inexistente recibe el mismo error",
    async () => {
      const response = await request(app)
        .post("/api/login")
        .send({
          email: "otro@nailflow.test",
          password: "Example2026!"
        });

      expect(
        response.body.error
      ).toBe("Credenciales incorrectas.");
    }
  );

  test(
    "usuario no puede crear ni editar materiales",
    async () => {
      const create = await withToken(
        app,
        user,
        "post",
        "/api/products"
      ).send(product);

      expect(create.status).toBe(403);

      const edit = await withToken(
        app,
        user,
        "put",
        "/api/products/1"
      ).send(product);

      expect(edit.status).toBe(403);
    }
  );

  test(
    "flujo de alta, consumo, alerta, entrada, edición y bitácora",
    async () => {
      const created = await withToken(
        app,
        admin,
        "post",
        "/api/products"
      ).send(product);

      expect(created.status).toBe(201);

      const id = created.body.id;

      const consumed = await withToken(
        app,
        user,
        "post",
        `/api/products/${id}/movements`
      ).send({
        type: "consumo",
        quantity: 7,
        note: "Servicio de manicure"
      });

      expect(consumed.body.quantity).toBe(3);
      expect(consumed.body.lowStock).toBe(true);

      const entered = await withToken(
        app,
        admin,
        "post",
        `/api/products/${id}/movements`
      ).send({
        type: "entrada",
        quantity: 5,
        note: "Compra"
      });

      expect(entered.body.quantity).toBe(8);
      expect(entered.body.lowStock).toBe(false);

      const edited = await withToken(
        app,
        admin,
        "put",
        `/api/products/${id}`
      ).send({
        ...product,
        name: "Esmalte rojo"
      });

      expect(
        edited.body.name
      ).toBe("Esmalte rojo");

      const products = await withToken(
        app,
        user,
        "get",
        "/api/products"
      );

      expect(products.body).toHaveLength(1);

      const movements = await withToken(
        app,
        user,
        "get",
        "/api/movements"
      );

      expect(movements.body).toHaveLength(3);
    }
  );

  test.each([
    [
      {
        ...product,
        quantity: -1
      },
      400
    ],
    [
      {
        ...product,
        minimum: 1.5
      },
      400
    ],
    [
      {
        ...product,
        name: "<script>alert(1)</script>"
      },
      400
    ],
    [
      {
        ...product,
        unit: ""
      },
      400
    ]
  ])(
    "rechaza altas inválidas %p",
    async (data, status) => {
      const response = await withToken(
        app,
        admin,
        "post",
        "/api/products"
      ).send(data);

      expect(response.status).toBe(status);
    }
  );

  test(
    "consumos inválidos no modifican existencias",
    async () => {
      const created = await withToken(
        app,
        admin,
        "post",
        "/api/products"
      ).send(product);

      const id = created.body.id;

      const invalidMovements = [
        [
          {
            type: "otro",
            quantity: 1,
            note: "Servicio"
          },
          400
        ],
        [
          {
            type: "consumo",
            quantity: 0,
            note: "Servicio"
          },
          400
        ],
        [
          {
            type: "consumo",
            quantity: 11,
            note: "Servicio"
          },
          409
        ],
        [
          {
            type: "consumo",
            quantity: 1,
            note: "<img src=x onerror=alert(1)>"
          },
          400
        ],
        [
          {
            type: "entrada",
            quantity: 1,
            note: "Compra"
          },
          403
        ]
      ];

      for (
        const [data, status] of invalidMovements
      ) {
        const response = await withToken(
          app,
          user,
          "post",
          `/api/products/${id}/movements`
        ).send(data);

        expect(response.status).toBe(status);
      }

      expect(
        store.getProduct(id).quantity
      ).toBe(10);

      const missing = await withToken(
        app,
        admin,
        "post",
        "/api/products/999/movements"
      ).send({
        type: "consumo",
        quantity: 1,
        note: "Servicio"
      });

      expect(missing.status).toBe(404);
    }
  );

  test(
    "inyección SQL e identificadores manipulados no son aceptados",
    async () => {
      const login = await request(app)
        .post("/api/login")
        .send({
          email: "' OR 1=1 --",
          password: "Example2026!"
        });

      expect(login.status).toBe(400);

      const edit = await withToken(
        app,
        admin,
        "put",
        "/api/products/1%20OR%201=1"
      ).send(product);

      expect(edit.status).toBe(400);

      const users = store.db.prepare(`
        SELECT COUNT(*) AS n FROM users
      `).get();

      expect(users.n).toBe(2);
    }
  );

  test(
    "sesión expira por inactividad y se revoca",
    async () => {
      now += 15 * 60 * 1000;

      const first = await withToken(
        app,
        user,
        "get",
        "/api/products"
      );

      expect(first.status).toBe(401);

      const second = await withToken(
        app,
        user,
        "get",
        "/api/products"
      );

      expect(second.status).toBe(401);
    }
  );

  test(
    "actividad antes del límite prolonga la sesión",
    async () => {
      now += 14 * 60 * 1000;

      const first = await withToken(
        app,
        user,
        "get",
        "/api/products"
      );

      expect(first.status).toBe(200);

      now += 14 * 60 * 1000;

      const second = await withToken(
        app,
        user,
        "get",
        "/api/products"
      );

      expect(second.status).toBe(200);
    }
  );

  test(
    "cerrar sesión impide reutilizar el token",
    async () => {
      const logout = await withToken(
        app,
        user,
        "post",
        "/api/logout"
      );

      expect(logout.status).toBe(204);

      const products = await withToken(
        app,
        user,
        "get",
        "/api/products"
      );

      expect(products.status).toBe(401);
    }
  );

  test(
    "tokens incorrectos o vencidos fallan",
    async () => {
      const sid = jwt.decode(user).sid;

      const options = {
        algorithm: "HS256",
        issuer: "nailflow",
        audience: "nailflow-web",
        subject: "999"
      };

      const invalidTokens = [
        jwt.sign(
          { sid },
          secret,
          options
        ),
        jwt.sign(
          { sid },
          "otro-secreto",
          options
        ),
        jwt.sign(
          { sid },
          secret,
          {
            ...options,
            expiresIn: -1
          }
        ),
        jwt.sign(
          {},
          secret,
          options
        )
      ];

      for (const token of invalidTokens) {
        const response = await withToken(
          app,
          token,
          "get",
          "/api/products"
        );

        expect(response.status).toBe(401);
      }
    }
  );

  test(
    "limita intentos repetidos de inicio de sesión",
    async () => {
      const limited = createApp({
        store,
        secret,
        loginLimit: 2
      });

      for (let i = 0; i < 2; i++) {
        await request(limited)
          .post("/api/login")
          .send({
            email: "otro@nailflow.test",
            password: "Example2026!"
          });
      }

      const response = await request(limited)
        .post("/api/login")
        .send({
          email: "otro@nailflow.test",
          password: "Example2026!"
        });

      expect(response.status).toBe(429);
    }
  );

  test(
    "rechaza JSON mal formado y solicitudes grandes",
    async () => {
      const malformed = await request(app)
        .post("/api/login")
        .set(
          "Content-Type",
          "application/json"
        )
        .send("{");

      expect(malformed.status).toBe(400);

      const large = await request(app)
        .post("/api/login")
        .send({
          value: "a".repeat(11000)
        });

      expect(large.status).toBe(413);

      const empty = await request(app)
        .post("/api/login")
        .send({});

      expect(empty.status).toBe(400);
    }
  );

  test(
    "oculta los detalles de errores internos",
    async () => {
      store.listProducts = () => {
        throw new Error(
          "SQL /private/db.sqlite"
        );
      };

      const response = await withToken(
        app,
        admin,
        "get",
        "/api/products"
      );

      expect(response.status).toBe(500);

      expect(
        response.body.error
      ).not.toContain("SQL");
    }
  );
});