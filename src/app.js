const express = require("express");
const helmet = require("helmet");

const {
  rateLimit
} = require("express-rate-limit");

const {
  join
} = require("node:path");

const {
  createAuth
} = require("./auth");

const {
  AppError
} = require("./errors");

const validation = require("./validation");

function createApp({
  store,
  secret,
  clock,
  loginLimit = 10
}) {
  const app = express();
  const auth = createAuth(store, secret, clock);

  // Oculta información sobre Express.
  app.disable("x-powered-by");

  // Solo Nginx en la misma instancia puede informar la IP real del cliente.
  app.set("trust proxy", "loopback");

  // Agrega encabezados de seguridad.
  app.use(
    helmet({
      crossOriginEmbedderPolicy: {
        policy: "require-corp"
      },
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          fontSrc: ["'self'"],
          imgSrc: ["'self'"],
          connectSrc: ["'self'"],
          mediaSrc: ["'none'"],
          childSrc: ["'none'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null
        }
      }
    })
  );

  // Restringe funciones del navegador en todas las respuestas.
  app.use((req, res, next) => {
    res.set(
      "Permissions-Policy",
      "camera=(), geolocation=(), microphone=(), payment=(), usb=()"
    );
    next();
  });

  // Evita guardar respuestas privadas en la caché.
  app.use("/api", (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  });

  // Permite recibir información en formato JSON.
  app.use(
    express.json({
      limit: "10kb"
    })
  );

  // Ruta sencilla para comprobar que la API funciona.
  app.get("/api/health", (req, res) => {
    res.json({
      status: "ok",
      service: "NailFlow"
    });
  });

  // Limita los intentos de registro e inicio de sesión.
  const accessLimit = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: loginLimit,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    message: {
      error:
        "Demasiados intentos. Espera antes de volver a intentar."
    }
  });

  // Inicia una sesión.
  app.post(
    "/api/login",
    accessLimit,
    (req, res) => {
      const {
        email,
        password
      } = validation.credentials(req.body);

      res.json(
        auth.login(email, password)
      );
    }
  );

  // Registra una cuenta nueva.
  app.post(
    "/api/register",
    accessLimit,
    (req, res) => {
      const {
        email,
        password
      } = validation.credentials(req.body);

      const result = auth.register(
        email,
        password
      );

      res.status(201).json(result);
    }
  );

  // A partir de aquí, todas las rutas de la API
  // necesitan un JWT y una sesión válida.
  app.use("/api", auth.authenticate);

  // Devuelve la cuenta que inició sesión.
  app.get("/api/me", (req, res) => {
    const {
      id,
      email,
      role
    } = req.user;

    res.json({
      id,
      email,
      role
    });
  });

  // Cierra la sesión actual.
  app.post("/api/logout", (req, res) => {
    store.deleteSession(req.user.sid);
    res.sendStatus(204);
  });

  // Devuelve todos los materiales.
  app.get("/api/products", (req, res) => {
    res.json(
      store.listProducts()
    );
  });

  // Registra un material.
  // Solamente puede hacerlo el administrador.
  app.post(
    "/api/products",
    auth.administrator,
    (req, res) => {
      const data = validation.product(req.body);

      const quantity = validation.integer(
        req.body.quantity,
        "Existencia inicial"
      );

      const product = store.addProduct(
        data,
        quantity,
        req.user.id
      );

      res.status(201).json(product);
    }
  );

  // Edita un material.
  // Solamente puede hacerlo el administrador.
  app.put(
    "/api/products/:id",
    auth.administrator,
    (req, res) => {
      const id = validation.id(req.params.id);
      const data = validation.product(req.body);

      const product = store.updateProduct(
        id,
        data
      );

      res.json(product);
    }
  );

  // Solo el administrador puede eliminar materiales.
  app.delete("/api/products/:id", auth.administrator, (req, res) => {
    store.deleteProduct(validation.id(req.params.id), req.user.id);
    res.sendStatus(204);
  });

  // Registra una entrada, consumo o salida.
  app.post(
    "/api/products/:id/movements",
    (req, res) => {
      const {
        type,
        quantity,
        note
      } = req.body;

      if (
        !["entrada", "consumo", "salida"].includes(type)
      ) {
        throw new AppError(
          "Tipo de movimiento no válido."
        );
      }

      // Solamente el administrador registra entradas y salidas especiales.
      if (
        type !== "consumo" &&
        req.user.role !== "administrador"
      ) {
        throw new AppError(
          "Solo el administrador registra entradas y salidas por defecto u otra causa.",
          403
        );
      }

      const id = validation.id(req.params.id);

      const amount = validation.integer(
        quantity,
        "Cantidad",
        1
      );

      const reason = validation.text(
        note,
        "Motivo",
        120
      );

      const product = store.move(
        id,
        req.user.id,
        type,
        amount,
        reason
      );

      res.status(201).json(product);
    }
  );

  // Devuelve el historial de movimientos.
  app.get("/api/movements", (req, res) => {
    res.json(
      store.movements()
    );
  });

  // Entrega los archivos de la pantalla.
  app.use(
    express.static(
      join(__dirname, "..", "public"),
      {
        dotfiles: "deny"
      }
    )
  );

  // Respuesta para una dirección inexistente.
  app.use((req, res) => {
    res.status(404).json({
      error: "Ruta no encontrada."
    });
  });

  // Maneja los errores de la aplicación.
  app.use((error, req, res, next) => {
    if (error instanceof AppError) {
      return res.status(error.status).json({
        error: error.message
      });
    }

    if (error.type === "entity.too.large") {
      return res.status(413).json({
        error: "Solicitud demasiado grande."
      });
    }

    if (
      error.type === "entity.parse.failed" ||
      error instanceof TypeError
    ) {
      return res.status(400).json({
        error: "Datos de solicitud no válidos."
      });
    }

    res.status(500).json({
      error: "No se pudo completar la operación."
    });
  });

  return app;
}

module.exports = {
  createApp
};
