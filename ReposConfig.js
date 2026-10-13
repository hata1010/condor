// ============================================================
// REPOSITORIOS — CONFIGURACIÓN
// Periodos fiscales, cuotas base, categorías de gasto,
// parámetros, tasas BCV.
// Soft delete universal (CRUD-in) donde aplique.
// ============================================================

// ------------------------------------------------------------
// PERIODOS FISCALES
// ------------------------------------------------------------
const RepoPeriodosFiscales = {

  listarPorCondominio: function(condominioId) {
    return sb.select("periodo_fiscal",
      "condominio_id=eq." + condominioId + "&order=anio.desc");
  },

  porId: function(id) {
    const res = sb.select("periodo_fiscal", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  /**
   * Devuelve el periodo ABIERTO del condominio, o null si no hay.
   * Regla RN-90: solo puede haber uno abierto por condominio.
   */
  abiertoPorCondominio: function(condominioId) {
    const res = sb.select("periodo_fiscal",
      "condominio_id=eq." + condominioId + "&estado=eq.ABIERTO");
    return res && res.length ? res[0] : null;
  },

  porAnio: function(condominioId, anio) {
    const res = sb.select("periodo_fiscal",
      "condominio_id=eq." + condominioId + "&anio=eq." + anio);
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("periodo_fiscal", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("periodo_fiscal", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  /**
   * Cierra un periodo fiscal (no se borra, se cierra).
   */
  cerrar: function(id) {
    return this.actualizar(id, {
      estado: "CERRADO",
      cerrado_at: new Date().toISOString()
    });
  },

  reabrir: function(id) {
    return this.actualizar(id, {
      estado: "ABIERTO",
      cerrado_at: null
    });
  }
};

// ------------------------------------------------------------
// CUOTAS BASE
// ------------------------------------------------------------
const RepoCuotasBase = {

  listarPorCondominio: function(condominioId) {
    return sb.select("cuotas_base",
      "condominio_id=eq." + condominioId + "&order=vigente_desde.desc");
  },

  porId: function(id) {
    const res = sb.select("cuotas_base", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  /**
   * Devuelve la cuota base vigente hoy para un condominio.
   * Vigente = estado ACTIVO y (vigente_hasta es null o >= hoy).
   */
  vigente: function(condominioId) {
    const hoy = new Date().toISOString().substring(0, 10);
    const res = sb.select("cuotas_base",
      "condominio_id=eq." + condominioId +
      "&estado=eq.ACTIVO" +
      "&vigente_desde=lte." + hoy +
      "&or=(vigente_hasta.is.null,vigente_hasta.gte." + hoy + ")" +
      "&order=vigente_desde.desc&limit=1");
    return res && res.length ? res[0] : null;
  },

  historial: function(condominioId) {
    return this.listarPorCondominio(condominioId);
  },

  crear: function(datos) {
    const res = sb.insert("cuotas_base", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("cuotas_base", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  /**
   * Cierra la vigencia de una cuota base (no se borra).
   * @param {string} id
   * @param {string} fechaCierre - formato YYYY-MM-DD
   */
  cerrarVigencia: function(id, fechaCierre) {
    return this.actualizar(id, {
      vigente_hasta: fechaCierre,
      estado: "INACTIVO"
    });
  },

  reactivar: function(id) {
    return this.actualizar(id, { estado: "ACTIVO" });
  }
};

// ------------------------------------------------------------
// CATEGORIAS DE GASTO
// ------------------------------------------------------------
const RepoCategoriasGasto = {

  listarPorCondominio: function(condominioId) {
    return sb.select("categorias_gasto",
      "condominio_id=eq." + condominioId +
      "&activo=eq.true&order=nombre.asc");
  },

  listarTodosPorCondominio: function(condominioId) {
    return sb.select("categorias_gasto",
      "condominio_id=eq." + condominioId + "&order=nombre.asc");
  },

  porModoCobro: function(condominioId, modoCobro) {
    return sb.select("categorias_gasto",
      "condominio_id=eq." + condominioId +
      "&modo_cobro=eq." + modoCobro +
      "&activo=eq.true&order=nombre.asc");
  },

  porId: function(id) {
    const res = sb.select("categorias_gasto", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  porNombre: function(condominioId, nombre) {
    const res = sb.select("categorias_gasto",
      "condominio_id=eq." + condominioId +
      "&nombre=eq." + encodeURIComponent(nombre));
    return res && res.length ? res[0] : null;
  },

  crear: function(datos) {
    const res = sb.insert("categorias_gasto", datos);
    return res && res.length ? res[0] : null;
  },

  actualizar: function(id, cambios) {
    const res = sb.update("categorias_gasto", "id=eq." + id, cambios);
    return res && res.length ? res[0] : null;
  },

  eliminar: function(id) {
    return this.actualizar(id, { activo: false });
  },

  reactivar: function(id) {
    return this.actualizar(id, { activo: true });
  }
};

// ------------------------------------------------------------
// PARAMETROS CONDOMINIO (mora, redondeo, topes)
// ------------------------------------------------------------
const RepoParametrosCondominio = {

  porCondominio: function(condominioId) {
    const res = sb.select("parametros_condominio",
      "condominio_id=eq." + condominioId);
    return res && res.length ? res[0] : null;
  },

  /**
   * Crea o actualiza los parámetros de un condominio.
   * Útil porque la tabla tiene unique(condominio_id).
   */
  crearOActualizar: function(condominioId, datos) {
    const existente = this.porCondominio(condominioId);
    if (existente) {
      return sb.update("parametros_condominio",
        "id=eq." + existente.id, datos);
    }
    datos.condominio_id = condominioId;
    return sb.insert("parametros_condominio", datos);
  },

  /**
   * Crea los parámetros con valores por defecto si no existen.
   */
  crearConDefaults: function(condominioId) {
    const existente = this.porCondominio(condominioId);
    if (existente) return existente;

    return sb.insert("parametros_condominio", {
      condominio_id: condominioId,
      mora_dias_gracia: 15,
      mora_tasa_mensual: 3.00,
      mora_notificar_a_meses: 3,
      mora_congelar: true,
      tope_egreso_fondo_ope: 70.00,
      redondeo_decimales: 2
    });
  }
};

// ------------------------------------------------------------
// PARAMETROS FONDO RESERVA
// ------------------------------------------------------------
const RepoParametrosFondoReserva = {

  porCondominio: function(condominioId) {
    const res = sb.select("parametros_fondo_reserva",
      "condominio_id=eq." + condominioId);
    return res && res.length ? res[0] : null;
  },

  crearOActualizar: function(condominioId, datos) {
    const existente = this.porCondominio(condominioId);
    if (existente) {
      return sb.update("parametros_fondo_reserva",
        "id=eq." + existente.id, datos);
    }
    datos.condominio_id = condominioId;
    return sb.insert("parametros_fondo_reserva", datos);
  },

  crearConDefaults: function(condominioId) {
    const existente = this.porCondominio(condominioId);
    if (existente) return existente;

    return sb.insert("parametros_fondo_reserva", {
      condominio_id: condominioId,
      porcentaje_cuota: 10.00,
      tope_evento_porcentaje: 30.00,
      aprobacion_asamblea_pct: 80.00,
      saldo_minimo_bs: 0,
      saldo_minimo_usd: 0,
      mantiene_bs: true,
      mantiene_usd: true
    });
  }
};

// ------------------------------------------------------------
// TASAS BCV
// ------------------------------------------------------------
const RepoTasasBCV = {

  listar: function(limite) {
    return sb.select("tasas_bcv",
      "order=fecha.desc&limit=" + (limite || 100));
  },

  /**
   * Devuelve la tasa más reciente (la del último día registrado).
   */
  ultima: function() {
    const res = sb.select("tasas_bcv", "order=fecha.desc&limit=1");
    return res && res.length ? res[0] : null;
  },

  porFecha: function(fecha) {
    const res = sb.select("tasas_bcv", "fecha=eq." + fecha);
    return res && res.length ? res[0] : null;
  },

  /**
   * Devuelve la tasa vigente en una fecha dada (la más reciente que sea <= fecha).
   */
  vigenteEn: function(fecha) {
    const res = sb.select("tasas_bcv",
      "fecha=lte." + fecha + "&order=fecha.desc&limit=1");
    return res && res.length ? res[0] : null;
  },

  rango: function(desde, hasta) {
    return sb.select("tasas_bcv",
      "fecha=gte." + desde + "&fecha=lte." + hasta + "&order=fecha.asc");
  },

  crear: function(datos) {
    const res = sb.insert("tasas_bcv", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Upsert: si ya existe una tasa para esa fecha, la actualiza.
   */
  guardar: function(fecha, tasa, fuente) {
  return sb.upsert("tasas_bcv", {
    fecha: fecha,
    tasa: tasa,
    fuente: fuente || "BCV"
  }, "fecha");
}
};

// ============================================================
// TEST — Repos de Configuración
// ============================================================
function testReposConfig() {
  Logger.log("=== TEST Repos de Configuración ===");

  const nombreTest = "Test Config Repo";

  // Limpieza previa
  const condPrevio = RepoCondominios.porNombre(nombreTest);
  if (condPrevio) {
    RepoCondominios.eliminar(condPrevio.id);
  }

  // Crear condominio de prueba
  Logger.log("\n--- Setup: Condominio ---");
  const cond = RepoCondominios.crear({
    nombre: nombreTest,
    email: "test@config.com"
  });
  Logger.log("Condominio: " + cond.id);

  // ============================================================
  // 1. PERIODOS FISCALES
  // ============================================================
  Logger.log("\n--- 1. Periodo Fiscal ---");
  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id,
    anio: 2026,
    desde: "2026-01-01",
    hasta: "2026-12-31",
    estado: "ABIERTO"
  });
  Logger.log("Creado periodo 2026: " + per.id);
  Logger.log("¿Hay periodo abierto? " + (RepoPeriodosFiscales.abiertoPorCondominio(cond.id) ? "SÍ" : "NO"));
  Logger.log("Listado: " + RepoPeriodosFiscales.listarPorCondominio(cond.id).length);

  // ============================================================
  // 2. CUOTAS BASE
  // ============================================================
  Logger.log("\n--- 2. Cuota Base ---");
  const cb = RepoCuotasBase.crear({
    condominio_id: cond.id,
    monto: 7000,
    monto_reserva: 700,
    vigente_desde: "2026-01-01",
    estado: "ACTIVO"
  });
  Logger.log("Cuota base creada: " + cb.id);
  const vigente = RepoCuotasBase.vigente(cond.id);
  Logger.log("Cuota vigente hoy: Bs " + (vigente ? vigente.monto : "NO HAY"));

  // ============================================================
  // 3. CATEGORIAS DE GASTO
  // ============================================================
  Logger.log("\n--- 3. Categorías ---");
  const cats = [
    { nombre: "Limpieza", modo_cobro: "FONDO_OPERATIVO" },
    { nombre: "Vigilancia", modo_cobro: "FONDO_OPERATIVO" },
    { nombre: "Reparación ascensor", modo_cobro: "FONDO_RESERVA" },
    { nombre: "Pintura fachada", modo_cobro: "REPARTO_DIRECTO" }
  ];

  cats.forEach(c => {
    c.condominio_id = cond.id;
    RepoCategoriasGasto.crear(c);
  });

  Logger.log("Total categorías: " + RepoCategoriasGasto.listarPorCondominio(cond.id).length);
  Logger.log("Fondo Operativo: " + RepoCategoriasGasto.porModoCobro(cond.id, "FONDO_OPERATIVO").length);
  Logger.log("Fondo Reserva: " + RepoCategoriasGasto.porModoCobro(cond.id, "FONDO_RESERVA").length);
  Logger.log("Reparto Directo: " + RepoCategoriasGasto.porModoCobro(cond.id, "REPARTO_DIRECTO").length);

  // ============================================================
  // 4. PARAMETROS CONDOMINIO
  // ============================================================
  Logger.log("\n--- 4. Parámetros Condominio ---");
  RepoParametrosCondominio.crearConDefaults(cond.id);
  let params = RepoParametrosCondominio.porCondominio(cond.id);
  Logger.log("Mora días gracia: " + params.mora_dias_gracia);
  Logger.log("Mora tasa: " + params.mora_tasa_mensual + "%");
  Logger.log("Mora congelar: " + params.mora_congelar);
  Logger.log("Tope egreso fondo ope: " + params.tope_egreso_fondo_ope + "%");

  // Actualizar
  RepoParametrosCondominio.crearOActualizar(cond.id, { mora_tasa_mensual: 5.00 });
  params = RepoParametrosCondominio.porCondominio(cond.id);
  Logger.log("Mora tasa actualizada: " + params.mora_tasa_mensual + "%");

  // ============================================================
  // 5. PARAMETROS FONDO RESERVA
  // ============================================================
  Logger.log("\n--- 5. Parámetros Fondo Reserva ---");
  RepoParametrosFondoReserva.crearConDefaults(cond.id);
  const fr = RepoParametrosFondoReserva.porCondominio(cond.id);
  Logger.log("Porcentaje cuota: " + fr.porcentaje_cuota + "%");
  Logger.log("Tope por evento: " + fr.tope_evento_porcentaje + "%");
  Logger.log("Aprobación asamblea: " + fr.aprobacion_asamblea_pct + "%");
  Logger.log("Mantiene Bs: " + fr.mantiene_bs);
  Logger.log("Mantiene USD: " + fr.mantiene_usd);

  // ============================================================
  // 6. TASAS BCV
  // ============================================================
  Logger.log("\n--- 6. Tasas BCV ---");
  RepoTasasBCV.guardar("2026-10-01", 36.50, "BCV");
  RepoTasasBCV.guardar("2026-10-05", 36.80, "BCV");
  RepoTasasBCV.guardar("2026-10-10", 37.10, "BCV");

  const ultima = RepoTasasBCV.ultima();
  Logger.log("Última tasa: " + ultima.tasa + " Bs/$ (" + ultima.fecha + ")");

  const vigenteOct6 = RepoTasasBCV.vigenteEn("2026-10-06");
  Logger.log("Tasa vigente 06/10: " + vigenteOct6.tasa);

  Logger.log("Historial (3 últimas): " + RepoTasasBCV.listar(3).length);

  // ============================================================
  // LIMPIEZA
  // ============================================================
  Logger.log("\n--- Limpieza (soft delete) ---");
  // Borramos los datos del test
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado (datos quedan en BD)");

  Logger.log("\n=== TEST FINALIZADO ===");
}