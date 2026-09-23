// Busca un elemento del HTML por su id.
function el(id) {
  return document.getElementById(id);
}

// Datos temporales de la sesión actual.
let token = null;
let user = null;
let products = [];
let editing = null;

// Muestra un mensaje en la pantalla.
function message(text) {
  el("message").textContent = text;
}

// Limpia la sesión y regresa al inicio.
function endSession() {
  token = null;
  user = null;
  editing = null;

  el("dashboard").hidden = true;
  el("login-panel").hidden = false;

  el("password").value = "";

  el("register-form").reset();
  el("register-form").hidden = true;
  el("login-form").hidden = false;
}

// Envía solicitudes a la API.
async function api(
  path,
  method = "GET",
  body
) {
  const headers = {};

  if (body) {
    headers["Content-Type"] =
      "application/json";
  }

  if (token) {
    headers.Authorization =
      `Bearer ${token}`;
  }

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(
    `/api${path}`,
    options
  );

  let data = null;

  if (response.status !== 204) {
    data = await response.json();
  }

  if (!response.ok) {
    if (
      response.status === 401 &&
      token
    ) {
      endSession();
    }

    throw new Error(
      data.error ||
      "No se pudo completar la solicitud."
    );
  }

  return data;
}

// Crea una celda para las tablas.
function cell(
  row,
  text,
  className
) {
  const tableCell =
    document.createElement("td");

  // textContent evita interpretar el dato como HTML.
  tableCell.textContent = text;

  if (className) {
    tableCell.className = className;
  }

  row.append(tableCell);

  return tableCell;
}

// Regresa el formulario de materiales
// a su estado inicial.
function resetProductForm() {
  editing = null;

  el("product-form").reset();
  el("quantity").disabled = false;

  el("product-form-title").textContent =
    "Registrar material";

  el("cancel-edit").hidden = true;
}

// Coloca un material en el formulario
// para poder editarlo.
function editProduct(product) {
  editing = product.id;

  for (
    const key of [
      "name",
      "unit",
      "quantity",
      "minimum"
    ]
  ) {
    el(key).value = product[key];
  }

  // La cantidad cambia mediante movimientos.
  el("quantity").disabled = true;

  el("cancel-edit").hidden = false;

  el("product-form-title").textContent =
    "Editar material";

  el("name").focus();
}

async function deleteProduct(product, button) {
  if (!window.confirm(
    `¿Eliminar ${product.name} del inventario? Tiene ${product.quantity} ${product.unit}. Se conservará su historial. Para descontar solo algunas unidades, registra una salida.`
  )) return;

  button.disabled = true;
  try {
    await api(`/products/${product.id}`, "DELETE");
    if (editing === product.id) resetProductForm();
    await refresh();
    message("Material eliminado. Su historial se conserva.");
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
}

// Muestra los materiales en la tabla.
function renderProducts() {
  const query =
    el("search").value.toLowerCase();

  el("products").replaceChildren();

  for (const product of products) {
    if (
      !product.name
        .toLowerCase()
        .includes(query)
    ) {
      continue;
    }

    const row =
      document.createElement("tr");

    const nameCell =
      cell(row, product.name);

    // El administrador puede seleccionar
    // el nombre para editarlo.
    if (user.role === "administrador") {
      const button =
        document.createElement("button");

      button.className =
        "material-button";

      button.textContent =
        product.name;

      button.type = "button";

      button.addEventListener(
        "click",
        () => editProduct(product)
      );

      nameCell.replaceChildren(button);
    }

    const unit = /^\d+$/.test(
      String(product.unit).trim()
    )
      ? "piezas"
      : product.unit;

    cell(
      row,
      `${product.quantity} ${unit}`
    );

    cell(
      row,
      product.minimum
    );

    cell(
      row,
      product.lowStock
        ? "Existencia baja"
        : "Disponible",
      product.lowStock
        ? "low"
        : "ok"
    );

    if (user.role === "administrador") {
      const actions = cell(row, "");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary";
      button.textContent = "Eliminar";
      button.setAttribute("aria-label", `Eliminar ${product.name}`);
      button.addEventListener("click", () => deleteProduct(product, button));
      actions.append(button);
    }

    el("products").append(row);
  }

  el("empty").hidden =
    products.length > 0;
}

// Actualiza materiales, alertas e historial.
async function refresh() {
  const [
    currentProducts,
    movements
  ] = await Promise.all([
    api("/products"),
    api("/movements")
  ]);

  products = currentProducts;

  el("count").textContent =
    products.length;

  const lowProducts =
    products.filter(
      product => product.lowStock
    );

  el("low-count").textContent =
    lowProducts.length;

  el("alerts").hidden =
    lowProducts.length === 0;

  el("alerts").textContent =
    `Revisa las existencias de: ${
      lowProducts
        .map(product => product.name)
        .join(", ")
    }.`;

  const selectedProduct =
    el("movement-product").value;

  el("movement-product")
    .replaceChildren();

  for (const product of products) {
    const option =
      document.createElement("option");

    option.value = product.id;
    option.textContent = product.name;

    el("movement-product")
      .append(option);
  }

  const previousStillExists =
    products.some(
      product =>
        String(product.id) ===
        selectedProduct
    );

  if (previousStillExists) {
    el("movement-product").value =
      selectedProduct;
  }

  renderProducts();

  el("history").replaceChildren();

  for (const movement of movements) {
    const row =
      document.createElement("tr");

    const values = [
      movement.deleted_at ? `${movement.name} (eliminado)` : movement.name,
      movement.type === "salida" ? "Salida por defecto u otra causa" : movement.type,
      movement.quantity,
      movement.note,
      new Date(
        movement.created_at
      ).toLocaleString("es-MX")
    ];

    for (const value of values) {
      cell(row, value);
    }

    el("history").append(row);
  }
}

// Evita enviar varias veces el mismo formulario.
async function submit(form, action) {
  const button =
    form.querySelector(
      "[type='submit']"
    );

  button.disabled = true;

  try {
    await action();
  } catch (error) {
    message(error.message);
  } finally {
    button.disabled = false;
  }
}

// Muestra el inventario después
// de iniciar una sesión.
async function beginSession(result) {
  token = result.token;
  user = result.user;

  resetProductForm();
  el("movement-form").reset();

  el("login-panel").hidden = true;
  el("dashboard").hidden = false;

  el("identity").textContent =
    `${user.email} · ${user.role}`;

  const isAdministrator =
    user.role === "administrador";

  el("admin-panel").hidden =
    !isAdministrator;

  el("entry-option").hidden =
    !isAdministrator;

  el("entry-option").disabled =
    !isAdministrator;

  el("exit-option").hidden = !isAdministrator;
  el("exit-option").disabled = !isAdministrator;
  el("actions-heading").hidden = !isAdministrator;
  el("movement-help").hidden = !isAdministrator;

  el("password").value = "";
  el("register-form").reset();

  await refresh();
}

// Inicia sesión.
el("login-form").addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submit(
      event.currentTarget,
      async () => {
        const result = await api(
          "/login",
          "POST",
          {
            email: el("email").value,
            password:
              el("password").value
          }
        );

        await beginSession(result);

        message("Sesión iniciada.");
      }
    );
  }
);

// Muestra el formulario de registro.
el("show-register").addEventListener(
  "click",
  () => {
    el("login-form").hidden = true;
    el("password").value = "";

    el("register-form").hidden = false;

    message("");

    el("register-email").focus();
  }
);

// Regresa al inicio de sesión.
el("show-login").addEventListener(
  "click",
  () => {
    el("register-form").reset();
    el("register-form").hidden = true;

    el("login-form").hidden = false;

    message("");

    el("email").focus();
  }
);

// Registra una cuenta.
el("register-form").addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submit(
      event.currentTarget,
      async () => {
        const password =
          el("register-password").value;

        const confirmation =
          el("register-confirm").value;

        if (password !== confirmation) {
          throw new Error(
            "Las contraseñas no coinciden."
          );
        }

        const result = await api(
          "/register",
          "POST",
          {
            email:
              el("register-email").value,
            password
          }
        );

        await beginSession(result);

        message(
          "Cuenta creada. Sesión iniciada."
        );
      }
    );
  }
);

// Registra o edita un material.
el("product-form").addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submit(
      event.currentTarget,
      async () => {
        const data = {
          name: el("name").value,
          unit: el("unit").value,
          minimum: Number(
            el("minimum").value
          )
        };

        if (!editing) {
          data.quantity = Number(
            el("quantity").value
          );
        }

        const path = editing
          ? `/products/${editing}`
          : "/products";

        const method = editing
          ? "PUT"
          : "POST";

        await api(
          path,
          method,
          data
        );

        resetProductForm();
        await refresh();

        message("Material guardado.");
      }
    );
  }
);

// Registra una entrada o consumo.
el("movement-form").addEventListener(
  "submit",
  event => {
    event.preventDefault();

    submit(
      event.currentTarget,
      async () => {
        const productId =
          el("movement-product").value;

        await api(
          `/products/${productId}/movements`,
          "POST",
          {
            type:
              el("movement-type").value,

            quantity: Number(
              el("movement-quantity").value
            ),

            note:
              el("movement-note").value
          }
        );

        el("movement-quantity").value =
          "";

        el("movement-note").value =
          "";

        await refresh();

        message(
          "Movimiento registrado."
        );
      }
    );
  }
);

// Cierra la sesión.
el("logout").addEventListener(
  "click",
  async () => {
    try {
      await api(
        "/logout",
        "POST"
      );

      endSession();

      message("Sesión cerrada.");
    } catch (error) {
      message(error.message);
    }
  }
);

// Filtra la tabla mientras se escribe.
el("search").addEventListener(
  "input",
  renderProducts
);

// Cancela la edición de un material.
el("cancel-edit").addEventListener(
  "click",
  resetProductForm
);
