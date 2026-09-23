const v = require("../src/validation");

const {
  hashPassword,
  verifyPassword,
  createAuth
} = require("../src/auth");

const {
  createStore
} = require("../src/store");

const {
  AppError
} = require("../src/errors");

const {
  mkdtempSync,
  rmSync
} = require("node:fs");

const {
  tmpdir
} = require("node:os");

const {
  join
} = require("node:path");


describe("Validaciones unitarias", () => {
  test("normaliza un nombre y un correo válidos", () => {
    expect(
      v.text(" Limas ", "Nombre")
    ).toBe("Limas");

    expect(
      v.text(" Limas/acrílico-180 ", "Nombre")
    ).toBe("Limas/acrílico-180");

    expect(
      v.credentials({
        email: "ADMIN@NAILFLOW.TEST",
        password: "Example2026!"
      }).email
    ).toBe("admin@nailflow.test");

    expect(
      v.product({
        name: "Esmalte",
        unit: "frascos",
        minimum: 3
      })
    ).toEqual({
      name: "Esmalte",
      unit: "frascos",
      minimum: 3
    });

    expect(v.id("12")).toBe(12);
  });

  test.each([
    null,
    12,
    "",
    " ",
    "<script>alert(1)</script>",
    "x".repeat(81)
  ])("rechaza texto inválido %p", value => {
    expect(() => {
      v.text(value, "Nombre");
    }).toThrow(AppError);
  });

  test.each([
    -1,
    1.5,
    "4",
    null,
    1000001,
    NaN
  ])("rechaza cantidad inválida %p", value => {
    expect(() => {
      v.integer(value, "Cantidad");
    }).toThrow(AppError);
  });

  test.each([
    "0",
    "-1",
    "1 OR 1=1",
    "1.5",
    "1000001",
    "abc"
  ])("rechaza identificador inválido %p", value => {
    expect(() => {
      v.id(value);
    }).toThrow(AppError);
  });

  test.each([
    {
      email: null,
      password: "Example2026!"
    },
    {
      email: "x".repeat(121),
      password: "Example2026!"
    },
    {
      email: "no-es-correo",
      password: "Example2026!"
    },
    {
      email: "a@b.test",
      password: null
    },
    {
      email: "a@b.test",
      password: ""
    },
    {
      email: "a@b.test",
      password: "x".repeat(129)
    }
  ])("rechaza credenciales inválidas %p", data => {
    expect(() => {
      v.credentials(data);
    }).toThrow(AppError);
  });

  test("acepta contraseñas cortas no vacías", () => {
    expect(
      v.credentials({
        email: "a@b.test",
        password: "corta"
      }).password
    ).toBe("corta");
  });

  test("acepta límites de cantidades", () => {
    expect(
      v.integer(0, "Cantidad")
    ).toBe(0);

    expect(
      v.integer(1000000, "Cantidad")
    ).toBe(1000000);

    expect(() => {
      v.integer(0, "Cantidad", 1);
    }).toThrow();
  });
});


describe("Contraseñas y secretos", () => {
  test("guarda un hash con sal diferente para la misma contraseña", () => {
    const hash = hashPassword("Example2026!");

    expect(
      hash
    ).not.toContain("Example2026!");

    expect(
      hash
    ).not.toBe(hashPassword("Example2026!"));

    expect(
      verifyPassword("Example2026!", hash)
    ).toBe(true);

    expect(
      verifyPassword("Otra2026!", hash)
    ).toBe(false);

    expect(
      verifyPassword("Example2026!", "salt:00")
    ).toBe(false);
  });

  test.each([
    undefined,
    1,
    "corta"
  ])("rechaza secretos inseguros %p", secret => {
    expect(() => {
      createAuth({}, secret);
    }).toThrow("JWT_SECRET");
  });
});


test(
  "conserva cuentas registradas al reabrir la base y mantiene un solo administrador",
  () => {
    const dir = mkdtempSync(
      join(tmpdir(), "registro-")
    );

    const filename = join(
      dir,
      "inventario.sqlite"
    );

    let store;

    try {
      store = createStore(filename);

      expect(
        store.registerUser(
          "primera@persistencia.test",
          hashPassword("Registro2026!")
        ).role
      ).toBe("administrador");

      store.close();

      store = createStore(filename);

      expect(
        verifyPassword(
          "Registro2026!",
          store.findUser(
            "primera@persistencia.test"
          ).password_hash
        )
      ).toBe(true);

      expect(
        store.registerUser(
          "segunda@persistencia.test",
          hashPassword("Registro2026!")
        ).role
      ).toBe("usuario");

      expect(
        store.listProducts()
      ).toHaveLength(0);
    } finally {
      if (store) {
        store.close();
      }

      rmSync(dir, {
        recursive: true,
        force: true
      });
    }
  }
);


describe(
  "Reglas unitarias del inventario y persistencia",
  () => {
    let store;
    let uid;

    beforeEach(() => {
      store = createStore();

      uid = store.addUser(
        "a@b.test",
        "hash",
        "administrador"
      );
    });

    afterEach(() => {
      store.close();
    });

    const data = {
      name: "Limas",
      unit: "piezas",
      minimum: 3
    };

    test(
      "genera alerta exactamente en el mínimo y debajo de él",
      () => {
        const product = store.addProduct(
          data,
          4,
          uid
        );

        expect(product.lowStock).toBe(false);

        expect(
          store.move(
            product.id,
            uid,
            "consumo",
            1,
            "Servicio"
          ).lowStock
        ).toBe(true);

        expect(
          store.move(
            product.id,
            uid,
            "consumo",
            3,
            "Servicio"
          ).quantity
        ).toBe(0);
      }
    );

    test(
      "un consumo rechazado conserva el saldo y la bitácora",
      () => {
        const product = store.addProduct(
          data,
          4,
          uid
        );

        expect(() => {
          store.move(
            product.id,
            uid,
            "consumo",
            5,
            "Servicio"
          );
        }).toThrow("suficientes");

        expect(
          store.getProduct(product.id).quantity
        ).toBe(4);

        expect(
          store.movements()
        ).toHaveLength(1);
      }
    );

    test(
      "dos consumos del último saldo solo permiten uno",
      () => {
        const product = store.addProduct(
          data,
          1,
          uid
        );

        store.move(
          product.id,
          uid,
          "consumo",
          1,
          "Servicio"
        );

        expect(() => {
          store.move(
            product.id,
            uid,
            "consumo",
            1,
            "Servicio"
          );
        }).toThrow();

        expect(
          store.getProduct(product.id).quantity
        ).toBe(0);
      }
    );

    test(
      "acepta entrada y rechaza superar el límite",
      () => {
        const product = store.addProduct(
          data,
          999999,
          uid
        );

        expect(
          store.move(
            product.id,
            uid,
            "entrada",
            1,
            "Compra"
          ).quantity
        ).toBe(1000000);

        expect(() => {
          store.move(
            product.id,
            uid,
            "entrada",
            1,
            "Compra"
          );
        }).toThrow("máximo");
      }
    );

    test(
      "evita duplicados y conserva la transacción",
      () => {
        store.addProduct(data, 0, uid);

        expect(() => {
          store.addProduct(data, 1, uid);
        }).toThrow("ya existe");

        expect(
          store.listProducts()
        ).toHaveLength(1);

        expect(
          store.movements()
        ).toHaveLength(0);
      }
    );

    test(
      "edita metadatos y rechaza un nombre duplicado",
      () => {
        const product = store.addProduct(
          data,
          4,
          uid
        );

        store.addProduct({
          ...data,
          name: "Acrílico"
        }, 4, uid);

        expect(
          store.updateProduct(product.id, {
            ...data,
            minimum: 5
          }).lowStock
        ).toBe(true);

        expect(() => {
          store.updateProduct(product.id, {
            ...data,
            name: "Acrílico"
          });
        }).toThrow("ya existe");

        expect(() => {
          store.updateProduct(999, data);
        }).toThrow("no encontrado");
      }
    );

    test(
      "revierte errores de integridad en movimientos y altas",
      () => {
        expect(() => {
          store.addProduct(data, 3, 999);
        }).toThrow();

        expect(
          store.listProducts()
        ).toHaveLength(0);

        const product = store.addProduct(
          data,
          3,
          uid
        );

        expect(() => {
          store.move(
            product.id,
            999,
            "consumo",
            1,
            "Servicio"
          );
        }).toThrow();

        expect(
          store.getProduct(product.id).quantity
        ).toBe(3);

        expect(() => {
          store.getProduct(999);
        }).toThrow("no encontrado");
      }
    );

    test(
      "guarda datos al cerrar y abrir la base de datos",
      () => {
        const dir = mkdtempSync(
          join(tmpdir(), "nailflow-unit-")
        );

        const filename = join(
          dir,
          "subdir",
          "db.sqlite"
        );

        const first = createStore(filename);

        const user = first.addUser(
          "persistencia@nailflow.test",
          "hash",
          "usuario"
        );

        first.addProduct(
          data,
          4,
          user
        );

        first.close();

        const second = createStore(filename);

        expect(
          second.listProducts()[0].quantity
        ).toBe(4);

        second.close();

        rmSync(dir, {
          recursive: true,
          force: true
        });
      }
    );
  }
);
