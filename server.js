const {
  join
} = require("node:path");

const {
  randomBytes
} = require("node:crypto");

const {
  createStore
} = require("./src/store");

const {
  createApp
} = require("./src/app");

// Crea o abre la base de datos permanente.
const databasePath =
  process.env.DB_PATH ||
  join(
    __dirname,
    "data",
    "inventario.sqlite"
  );

const store = createStore(databasePath);

// Usa la clave configurada o genera una temporal.
const secret =
  process.env.JWT_SECRET ||
  randomBytes(48).toString("hex");

// Conecta Express con la base de datos y la autenticación.
const app = createApp({
  store,
  secret
});

// Inicia el servidor.
const port = Number(
  process.env.PORT || 3000
);

const host =
  process.env.HOST || "127.0.0.1";

const server = app.listen(
  port,
  host,
  () => {
    const activePort =
      server.address().port;

    console.log(
      `NailFlow: http://localhost:${activePort}`
    );

    console.log(
      "Crea tu cuenta desde la pantalla de registro."
    );

    console.log(
      "La primera cuenta será administradora."
    );
  }
);

// Cierra correctamente el servidor y la base de datos.
function shutdown() {
  server.close(() => {
    store.close();
    process.exit(0);
  });
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);