// Estas funciones revisan los datos antes de guardarlos en la base.
const {
  AppError
} = require("./errors");

function text(value, label, max = 80) {
  if (typeof value !== "string") {
    throw new AppError(`${label} no es válido.`);
  }

  const clean = value.trim();

  // El nombre debe tener contenido y respetar la longitud permitida.
  if (clean.length === 0 || clean.length > max) {
    throw new AppError(`${label} no es válido.`);
  }

  // Permite letras, números y signos sencillos; rechaza etiquetas HTML.
  if (!/^[\p{L}\p{N} .,_()\/-]+$/u.test(clean)) {
    throw new AppError(`${label} no es válido.`);
  }

  return clean;
}

function integer(value, label, min = 0) {
  if (
    !Number.isSafeInteger(value) ||
    value < min ||
    value > 1000000
  ) {
    throw new AppError(
      `${label} debe ser un entero entre ${min} y 1000000.`
    );
  }

  return value;
}

function id(value) {
  if (!/^[1-9]\d*$/.test(String(value))) {
    throw new AppError("Identificador no válido.");
  }

  return integer(Number(value), "Identificador", 1);
}

function product(data) {
  return {
    name: text(data.name, "Nombre"),
    unit: text(data.unit, "Unidad", 25),
    minimum: integer(data.minimum, "Existencia mínima")
  };
}

function credentials(data) {
  const email = data.email;
  const password = data.password;

  // Primero comprueba el correo y después la contraseña.
  if (
    typeof email !== "string" ||
    email.length > 120 ||
    !/^[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}$/.test(email)
  ) {
    throw new AppError("Correo o contraseña no válidos.");
  }

  if (
    typeof password !== "string" ||
    password.length === 0 ||
    password.length > 128
  ) {
    throw new AppError("Correo o contraseña no válidos.");
  }

  return {
    email: email.toLowerCase(),
    password
  };
}

module.exports = {
  text,
  integer,
  id,
  product,
  credentials
};