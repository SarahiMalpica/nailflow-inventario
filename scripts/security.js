const {
  randomBytes
} = require("node:crypto");

const {
  mkdirSync,
  writeFileSync
} = require("node:fs");

const {
  createStore
} = require("../src/store");

const {
  createApp
} = require("../src/app");


async function prepareTestData(
  base,
  email,
  password,
  userEmail,
  userPassword
) {
  async function post(path, body, token) {
    const response = await fetch(base + path, {
      method: "POST",

      headers: {
        "Content-Type": "application/json",

        ...(token
          ? {
              Authorization: `Bearer ${token}`
            }
          : {})
      },

      body: JSON.stringify(body)
    });

    if (response.status !== 201) {
      throw new Error(
        "No se pudieron preparar los datos de prueba."
      );
    }

    return response.json();
  }

  const admin = await post(
    "/api/register",
    {
      email,
      password
    }
  );

  const user = await post(
    "/api/register",
    {
      email: userEmail,
      password: userPassword,
      role: "administrador"
    }
  );

  if (
    admin.user.role !== "administrador" ||
    user.user.role !== "usuario"
  ) {
    throw new Error(
      "La asignación de roles del registro falló."
    );
  }

  await post(
    "/api/products",
    {
      name: "Material de prueba",
      unit: "piezas",
      quantity: 10,
      minimum: 3
    },
    admin.token
  );
}


async function checkSecurity(
  base,
  email,
  password,
  userEmail,
  userPassword
) {
  const checks = [];

  async function http(
    path,
    method = "GET",
    body,
    token
  ) {
    return fetch(base + path, {
      method,

      headers: {
        ...(body
          ? {
              "Content-Type": "application/json"
            }
          : {}),

        ...(token
          ? {
              Authorization: `Bearer ${token}`
            }
          : {})
      },

      body: body
        ? JSON.stringify(body)
        : undefined
    });
  }

  function check(
    name,
    condition,
    expected,
    actual
  ) {
    checks.push({
      name,
      passed: Boolean(condition),
      expected,
      actual
    });
  }

  const login = await http(
    "/api/login",
    "POST",
    {
      email,
      password
    }
  );

  const admin = (
    await login.json()
  ).token;

  if (!admin) {
    throw new Error(
      "No fue posible iniciar la sesión de prueba."
    );
  }

  const userLogin = await http(
    "/api/login",
    "POST",
    {
      email: userEmail,
      password: userPassword
    }
  );

  const user = (
    await userLogin.json()
  ).token;

  const page = await http("/");

  const contentSecurityPolicy = page.headers.get(
    "content-security-policy"
  );

  check(
    "Política de scripts del mismo origen",
    contentSecurityPolicy?.includes(
      "script-src 'self'"
    ),
    "CSP restrictiva",
    contentSecurityPolicy
  );

  const embedderPolicy = page.headers.get(
    "cross-origin-embedder-policy"
  );

  check(
    "Política de aislamiento entre orígenes",
    embedderPolicy === "require-corp",
    "require-corp",
    embedderPolicy
  );

  const permissionsPolicy = page.headers.get(
    "permissions-policy"
  );

  const expectedPermissions =
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()";

  check(
    "Restricción de permisos del navegador",
    permissionsPolicy === expectedPermissions,
    expectedPermissions,
    permissionsPolicy
  );

  const contentType = page.headers.get(
    "x-content-type-options"
  );

  check(
    "Bloqueo de interpretación de tipos",
    contentType === "nosniff",
    "nosniff",
    contentType
  );

  const frameOptions = page.headers.get(
    "x-frame-options"
  );

  check(
    "Bloqueo de inclusión en marcos",
    frameOptions === "SAMEORIGIN",
    "SAMEORIGIN",
    frameOptions
  );

  const poweredBy = page.headers.get(
    "x-powered-by"
  );

  check(
    "Servidor sin cabecera de framework",
    !poweredBy,
    "ausente",
    poweredBy
  );

  const securityCases = [
    [
      "Inventario sin sesión",
      "/api/products",
      "GET",
      null,
      null,
      401
    ],
    [
      "JWT alterado",
      "/api/products",
      "GET",
      null,
      admin + "alterado",
      401
    ],
    [
      "Alta sin rol administrador",
      "/api/products",
      "POST",
      {
        name: "Prueba",
        unit: "piezas",
        quantity: 1,
        minimum: 0
      },
      user,
      403
    ],
    [
      "Entrada con rol usuario",
      "/api/products/1/movements",
      "POST",
      {
        type: "entrada",
        quantity: 1,
        note: "Compra"
      },
      user,
      403
    ],
    [
      "Intento de inyección SQL",
      "/api/login",
      "POST",
      {
        email: "' OR 1=1 --",
        password: "Injection2026!"
      },
      null,
      400
    ],
    [
      "Intento de XSS en nombre",
      "/api/products",
      "POST",
      {
        name: "<script>alert(1)</script>",
        unit: "piezas",
        quantity: 1,
        minimum: 0
      },
      admin,
      400
    ],
    [
      "Intento de XSS en bitácora",
      "/api/products/1/movements",
      "POST",
      {
        type: "consumo",
        quantity: 1,
        note: "<img src=x onerror=alert(1)>"
      },
      admin,
      400
    ],
    [
      "Consumo que dejaría saldo negativo",
      "/api/products/1/movements",
      "POST",
      {
        type: "consumo",
        quantity: 1000000,
        note: "Servicio"
      },
      user,
      409
    ],
    [
      "Intento de leer archivo de entorno",
      "/.env",
      "GET",
      null,
      null,
      404
    ]
  ];

  for (
    const [
      name,
      path,
      method,
      body,
      token,
      expected
    ] of securityCases
  ) {
    const response = await http(
      path,
      method,
      body,
      token
    );

    check(
      name,
      response.status === expected,
      expected,
      response.status
    );
  }

  const inventory = await http(
    "/api/products",
    "GET",
    null,
    admin
  );

  const cacheControl = inventory.headers.get(
    "cache-control"
  );

  check(
    "Información privada sin caché",
    cacheControl === "no-store",
    "no-store",
    cacheControl
  );

  await http(
    "/api/logout",
    "POST",
    null,
    user
  );

  const replay = await http(
    "/api/products",
    "GET",
    null,
    user
  );

  check(
    "Token reutilizado después de cerrar sesión",
    replay.status === 401,
    401,
    replay.status
  );

  return {
    tool: "Pruebas dinámicas propias por HTTP",
    executedAt: new Date().toISOString(),
    target: base,
    total: checks.length,
    passed: checks.filter(
      result => result.passed
    ).length,
    checks,
    limitations:
      "Comprueba casos concretos de autenticación, autorización, XSS, SQLi y existencias. No reemplaza el análisis general de OWASP ZAP."
  };
}


async function main() {
  const store = createStore();

  const app = createApp({
    store,
    secret: randomBytes(48).toString("hex")
  });

  const server = app.listen(
    0,
    "127.0.0.1"
  );

  await new Promise(resolve => {
    server.once("listening", resolve);
  });

  try {
    const base =
      `http://127.0.0.1:${server.address().port}`;

    const adminEmail =
      "admin@security.test";

    const adminPassword =
      "SecurityAdmin2026!";

    const userEmail =
      "user@security.test";

    const userPassword =
      "SecurityUser2026!";

    await prepareTestData(
      base,
      adminEmail,
      adminPassword,
      userEmail,
      userPassword
    );

    const report = await checkSecurity(
      base,
      adminEmail,
      adminPassword,
      userEmail,
      userPassword
    );

    mkdirSync(
      "evidencias-del-proyecto",
      {
        recursive: true
      }
    );

    writeFileSync(
      "evidencias-del-proyecto/seguridad-http.json",
      JSON.stringify(
        report,
        null,
        2
      )
    );

    console.log(
      `${report.passed}/${report.total} controles HTTP aprobados.`
    );

    if (report.passed !== report.total) {
      process.exitCode = 1;
    }
  } finally {
    await new Promise(resolve => {
      server.close(resolve);
    });

    store.close();
  }
}


if (require.main === module) {
  main().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}


module.exports = {
  checkSecurity,
  prepareTestData
};
