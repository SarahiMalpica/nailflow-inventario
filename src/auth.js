const {
  randomBytes,
  scryptSync,
  timingSafeEqual,
  randomUUID
} = require("node:crypto");

const jwt = require("jsonwebtoken");

const {
  AppError
} = require("./errors");

function hashPassword(password) {
  // Genera una sal distinta para cada contraseña.
  const salt = randomBytes(16).toString("hex");

  // Guarda el resultado protegido, no la contraseña original.
  const hash = scryptSync(password, salt, 64).toString("hex");

  return `${salt}:${hash}`;
}

function verifyPassword(password, encoded) {
  const [salt, hash] = encoded.split(":");

  const actual = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, "hex");

  return (
    actual.length === expected.length &&
    timingSafeEqual(actual, expected)
  );
}

function administrator(req, res, next) {
  if (req.user.role !== "administrador") {
    return next(
      new AppError(
        "Necesitas permisos de administrador.",
        403
      )
    );
  }

  next();
}

function createAuth(store, secret, clock = Date.now) {
  if (typeof secret !== "string" || secret.length < 32) {
    throw new Error(
      "JWT_SECRET debe contener por lo menos 32 caracteres."
    );
  }

  // Evita responder más rápido cuando un correo no existe.
  const dummyHash = hashPassword(
    randomBytes(24).toString("hex")
  );

  function login(email, password) {
    const user = store.findUser(email);

    const valid = verifyPassword(
      password,
      user ? user.password_hash : dummyHash
    );

    if (!user || !valid) {
      throw new AppError(
        "Credenciales incorrectas.",
        401
      );
    }

    const sessionId = randomUUID();

    store.newSession(
      sessionId,
      user.id,
      clock()
    );

    const token = jwt.sign(
      {
        sid: sessionId
      },
      secret,
      {
        algorithm: "HS256",
        subject: String(user.id),
        issuer: "nailflow",
        audience: "nailflow-web",
        expiresIn: "1h"
      }
    );

    return {
      token,
      user: {
        id: user.id,
        email: user.email,
        role: user.role
      }
    };
  }

  function register(email, password) {
    // El rol se determina en store.js, no en el formulario.
    const passwordHash = hashPassword(password);

    store.registerUser(
      email,
      passwordHash
    );

    // Después del registro, inicia la sesión automáticamente.
    return login(email, password);
  }

  function authenticate(req, res, next) {
    try {
      const header = req.get("authorization");

      if (!header?.startsWith("Bearer ")) {
        throw new AppError(
          "Inicia sesión para continuar.",
          401
        );
      }

      let claims;

      try {
        claims = jwt.verify(
          header.slice(7),
          secret,
          {
            algorithms: ["HS256"],
            issuer: "nailflow",
            audience: "nailflow-web"
          }
        );
      } catch {
        throw new AppError(
          "La sesión no es válida o ha vencido.",
          401
        );
      }

      if (
        typeof claims !== "object" ||
        typeof claims.sid !== "string" ||
        typeof claims.sub !== "string"
      ) {
        throw new AppError(
          "La sesión no es válida.",
          401
        );
      }

      const session = store.session(claims.sid);

      if (
        !session ||
        String(session.user_id) !== claims.sub
      ) {
        throw new AppError(
          "Sesión cerrada.",
          401
        );
      }

      const inactiveTime =
        clock() - session.last_seen;

      if (inactiveTime >= 15 * 60 * 1000) {
        store.deleteSession(claims.sid);

        throw new AppError(
          "La sesión terminó por inactividad.",
          401
        );
      }

      store.touchSession(
        claims.sid,
        clock()
      );

      req.user = {
        id: session.user_id,
        email: session.email,
        role: session.role,
        sid: claims.sid
      };

      next();
    } catch (error) {
      next(error);
    }
  }

  return {
    login,
    register,
    authenticate,
    administrator
  };
}

module.exports = {
  hashPassword,
  verifyPassword,
  createAuth
};
