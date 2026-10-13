// ============================================================
// REPOSITORIOS — FONDOS
// Fondo Operativo + Fondo de Reserva.
//
// El saldo NO se guarda: se calcula como sum(ENTRADA) - sum(SALIDA).
// Esto garantiza que nunca haya inconsistencia entre saldo e historial.
// ============================================================

// ------------------------------------------------------------
// FONDO OPERATIVO
// ------------------------------------------------------------
const RepoFondoOperativo = {

  porId: function(id) {
    const res = sb.select("movimientos_fondo_operativo", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  listarPorCondominio: function(condominioId, filtros) {
    filtros = filtros || {};
    let q = "condominio_id=eq." + condominioId + "&order=fecha.desc,created_at.desc";
    if (filtros.tipo) q += "&tipo=eq." + filtros.tipo;
    if (filtros.periodoFiscalId) q += "&periodo_fiscal_id=eq." + filtros.periodoFiscalId;
    if (filtros.desde) q += "&fecha=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha=lte." + filtros.hasta;
    return sb.select("movimientos_fondo_operativo", q);
  },

  listarPorPeriodo: function(periodoFiscalId) {
    return sb.select("movimientos_fondo_operativo",
      "periodo_fiscal_id=eq." + periodoFiscalId + "&order=fecha.asc,created_at.asc");
  },

  /**
   * Calcula el saldo actual del fondo operativo.
   * Trae TODOS los movimientos y calcula en memoria (simple y confiable).
   */
  saldo: function(condominioId) {
    const movs = sb.select("movimientos_fondo_operativo",
      "condominio_id=eq." + condominioId + "&select=tipo,monto");
    let saldo = 0;
    movs.forEach(m => {
      saldo += (m.tipo === "ENTRADA") ? parseFloat(m.monto) : -parseFloat(m.monto);
    });
    return Math.round(saldo * 100) / 100;
  },

  /**
   * Saldo por periodo (para reportes de cierre).
   */
  saldoPorPeriodo: function(periodoFiscalId) {
    const movs = this.listarPorPeriodo(periodoFiscalId);
    let entradas = 0, salidas = 0;
    movs.forEach(m => {
      if (m.tipo === "ENTRADA") entradas += parseFloat(m.monto);
      else salidas += parseFloat(m.monto);
    });
    return {
      entradas: Math.round(entradas * 100) / 100,
      salidas: Math.round(salidas * 100) / 100,
      saldo: Math.round((entradas - salidas) * 100) / 100
    };
  },

  /**
   * Registra un movimiento de entrada.
   */
  registrarEntrada: function(datos) {
    datos.tipo = "ENTRADA";
    const res = sb.insert("movimientos_fondo_operativo", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Registra un movimiento de salida.
   */
  registrarSalida: function(datos) {
    datos.tipo = "SALIDA";
    const res = sb.insert("movimientos_fondo_operativo", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Registra un ajuste (para corregir diferencias).
   * tipo debe ser ENTRADA o SALIDA.
   */
  registrarAjuste: function(condominioId, tipo, monto, descripcion) {
    return sb.insert("movimientos_fondo_operativo", {
      condominio_id: condominioId,
      fecha: new Date().toISOString().substring(0, 10),
      tipo: tipo,
      monto: monto,
      origen_tipo: "AJUSTE",
      descripcion: descripcion || "Ajuste manual"
    });
  },

  /**
   * Saldo agrupado por origen (útil para reportes).
   */
  resumenPorOrigen: function(condominioId) {
    const movs = sb.select("movimientos_fondo_operativo",
      "condominio_id=eq." + condominioId + "&select=tipo,origen_tipo,monto");
    const resumen = {};
    movs.forEach(m => {
      const key = m.origen_tipo;
      if (!resumen[key]) resumen[key] = { entradas: 0, salidas: 0 };
      if (m.tipo === "ENTRADA") resumen[key].entradas += parseFloat(m.monto);
      else resumen[key].salidas += parseFloat(m.monto);
    });
    return resumen;
  }
};

// ------------------------------------------------------------
// FONDO DE RESERVA
// ------------------------------------------------------------
const RepoFondoReserva = {

  porId: function(id) {
    const res = sb.select("movimientos_fondo_reserva", "id=eq." + id);
    return res && res.length ? res[0] : null;
  },

  listarPorCondominio: function(condominioId, filtros) {
    filtros = filtros || {};
    let q = "condominio_id=eq." + condominioId + "&order=fecha.desc,created_at.desc";
    if (filtros.tipo) q += "&tipo=eq." + filtros.tipo;
    if (filtros.moneda) q += "&moneda=eq." + filtros.moneda;
    if (filtros.periodoFiscalId) q += "&periodo_fiscal_id=eq." + filtros.periodoFiscalId;
    if (filtros.desde) q += "&fecha=gte." + filtros.desde;
    if (filtros.hasta) q += "&fecha=lte." + filtros.hasta;
    return sb.select("movimientos_fondo_reserva", q);
  },

  listarPorPeriodo: function(periodoFiscalId) {
    return sb.select("movimientos_fondo_reserva",
      "periodo_fiscal_id=eq." + periodoFiscalId + "&order=fecha.asc,created_at.asc");
  },

  /**
   * Saldo del fondo de reserva, separado por moneda.
   * Devuelve { bs, usd, bs_equivalente }.
   *
   * bs = saldo en bolívares nativos
   * usd = saldo en dólares nativos
   * bs_equivalente = saldo total convertido a Bs usando la última tasa
   */
  saldo: function(condominioId) {
    const movs = sb.select("movimientos_fondo_reserva",
      "condominio_id=eq." + condominioId + "&select=tipo,moneda,monto,monto_bs");

    let saldoBs = 0;
    let saldoUsd = 0;

    movs.forEach(m => {
      const monto = parseFloat(m.monto);
      const montoBs = parseFloat(m.monto_bs);
      const signo = m.tipo === "ENTRADA" ? 1 : -1;

      if (m.moneda === "BS") {
        saldoBs += signo * monto;
      } else {
        saldoUsd += signo * monto;
      }
    });

    // Convertir USD a Bs para el saldo equivalente
    let tasaActual = 0;
    try {
      const ultimaTasa = RepoTasasBCV.ultima();
      tasaActual = ultimaTasa ? parseFloat(ultimaTasa.tasa) : 0;
    } catch (e) {
      tasaActual = 0;
    }

    return {
      bs: Math.round(saldoBs * 100) / 100,
      usd: Math.round(saldoUsd * 100) / 100,
      bs_equivalente: Math.round((saldoBs + saldoUsd * tasaActual) * 100) / 100
    };
  },

  saldoPorPeriodo: function(periodoFiscalId) {
    const movs = this.listarPorPeriodo(periodoFiscalId);
    let entBs = 0, salBs = 0, entUsd = 0, salUsd = 0;
    movs.forEach(m => {
      const monto = parseFloat(m.monto);
      if (m.tipo === "ENTRADA") {
        if (m.moneda === "BS") entBs += monto;
        else entUsd += monto;
      } else {
        if (m.moneda === "BS") salBs += monto;
        else salUsd += monto;
      }
    });
    return {
      entradas_bs: Math.round(entBs * 100) / 100,
      salidas_bs: Math.round(salBs * 100) / 100,
      entradas_usd: Math.round(entUsd * 100) / 100,
      salidas_usd: Math.round(salUsd * 100) / 100,
      saldo_bs: Math.round((entBs - salBs) * 100) / 100,
      saldo_usd: Math.round((entUsd - salUsd) * 100) / 100
    };
  },

  /**
   * Registra entrada al fondo de reserva.
   * origen_tipo puede ser: APORTE_CUOTA, AJUSTE, TRANSFERENCIA
   */
  registrarEntrada: function(datos) {
    datos.tipo = "ENTRADA";

    // Si la moneda es BS, monto_bs = monto
    // Si es USD, monto_bs = monto * tasa_bcv
    if (!datos.monto_bs) {
      if (datos.moneda === "USD" && datos.tasa_bcv) {
        datos.monto_bs = Math.round(datos.monto * datos.tasa_bcv * 100) / 100;
      } else {
        datos.monto_bs = datos.monto;
      }
    }

    const res = sb.insert("movimientos_fondo_reserva", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Registra salida del fondo de reserva.
   * IMPORTANTE: debe ser aprobado por asamblea (validar en servicio).
   */
  registrarSalida: function(datos) {
    datos.tipo = "SALIDA";

    if (!datos.monto_bs) {
      if (datos.moneda === "USD" && datos.tasa_bcv) {
        datos.monto_bs = Math.round(datos.monto * datos.tasa_bcv * 100) / 100;
      } else {
        datos.monto_bs = datos.monto;
      }
    }

    const res = sb.insert("movimientos_fondo_reserva", datos);
    return res && res.length ? res[0] : null;
  },

  /**
   * Verifica si un egreso del reserva cumple con el tope por evento.
   * @return {boolean} true si pasa el tope
   */
  verificarTope: function(condominioId, montoSalida) {
    // Obtener parámetros del fondo reserva
    const params = RepoParametrosFondoReserva.porCondominio(condominioId);
    if (!params) return { ok: true, motivo: "Sin parámetros configurados" };

    const saldo = this.saldo(condominioId);
    const tope = saldo.bs_equivalente * (parseFloat(params.tope_evento_porcentaje) / 100);

    if (montoSalida > tope) {
      return {
        ok: false,
        motivo: "El monto (" + montoSalida + " Bs) excede el tope por evento (" + tope.toFixed(2) + " Bs = " + params.tope_evento_porcentaje + "% del saldo).",
        tope: tope,
        saldo: saldo.bs
      };
    }

    return { ok: true, tope: tope, saldo: saldo.bs };
  }
};

// ============================================================
// TEST — Repos de Fondos
// ============================================================
function testReposFondos() {
  Logger.log("=== TEST Repos de Fondos ===");

  const nombreTest = "Test Fondos Repo";
  const previo = RepoCondominios.porNombre(nombreTest);
  if (previo) RepoCondominios.eliminar(previo.id);

  // Setup
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({
    nombre: nombreTest,
    email: "test@fondos.com"
  });
  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id,
    anio: 2026,
    desde: "2026-01-01",
    hasta: "2026-12-31",
    estado: "ABIERTO"
  });

  // Parámetros para tope
  RepoParametrosFondoReserva.crearConDefaults(cond.id);

  Logger.log("Setup OK");

  // ============================================================
  // FONDO OPERATIVO
  // ============================================================
  Logger.log("\n--- FONDO OPERATIVO ---");

  // Saldo inicial (0)
  Logger.log("Saldo inicial: Bs " + RepoFondoOperativo.saldo(cond.id));

  // 3 entradas (simulando 3 pagos de cuotas)
  RepoFondoOperativo.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-01",
    monto: 7000,
    origen_tipo: "PAGO",
    descripcion: "Pago cuota Octubre - Apto 1-A"
  });
  RepoFondoOperativo.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-02",
    monto: 7000,
    origen_tipo: "PAGO",
    descripcion: "Pago cuota Octubre - Apto 1-B"
  });
  RepoFondoOperativo.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-03",
    monto: 7000,
    origen_tipo: "PAGO",
    descripcion: "Pago cuota Octubre - Apto 1-C"
  });
  Logger.log("3 entradas registradas");

  // 1 salida (simulando un gasto operativo)
  RepoFondoOperativo.registrarSalida({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-15",
    monto: 8000,
    origen_tipo: "EGRESO",
    descripcion: "Pago limpieza octubre"
  });
  Logger.log("1 salida registrada");

  // Saldo después
  const saldoOpe = RepoFondoOperativo.saldo(cond.id);
  Logger.log("Saldo actual: Bs " + saldoOpe + " (esperado: 13000)");

  // Saldo del periodo
  const saldoPer = RepoFondoOperativo.saldoPorPeriodo(per.id);
  Logger.log("Periodo: entradas Bs " + saldoPer.entradas + ", salidas Bs " + saldoPer.salidas + ", saldo Bs " + saldoPer.saldo);

  // ============================================================
  // FONDO DE RESERVA
  // ============================================================
  Logger.log("\n--- FONDO DE RESERVA ---");

  Logger.log("Saldo inicial: " + JSON.stringify(RepoFondoReserva.saldo(cond.id)));

  // Entradas en Bs (simulando 10% de 3 pagos)
  RepoFondoReserva.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-01",
    moneda: "BS",
    monto: 700,
    origen_tipo: "APORTE_CUOTA",
    descripcion: "10% del pago de Octubre - 1-A"
  });
  RepoFondoReserva.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-02",
    moneda: "BS",
    monto: 700,
    origen_tipo: "APORTE_CUOTA",
    descripcion: "10% del pago de Octubre - 1-B"
  });
  RepoFondoReserva.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-03",
    moneda: "BS",
    monto: 700,
    origen_tipo: "APORTE_CUOTA",
    descripcion: "10% del pago de Octubre - 1-C"
  });
  Logger.log("3 entradas en Bs (2100 Bs)");

  // Entrada en USD (un propietario aportó en divisas)
  RepoFondoReserva.registrarEntrada({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-05",
    moneda: "USD",
    monto: 50,
    tasa_bcv: 37.10,
    origen_tipo: "APORTE_CUOTA",
    descripcion: "Aporte en divisas - Apto 2-A"
  });
  Logger.log("1 entrada en USD (50$)");

  // Salida
  RepoFondoReserva.registrarSalida({
    condominio_id: cond.id,
    periodo_fiscal_id: per.id,
    fecha: "2026-10-20",
    moneda: "BS",
    monto: 1000,
    origen_tipo: "EGRESO_RESERVA",
    descripcion: "Reparación menor autorizada",
    aprobado_asamblea: false
  });
  Logger.log("1 salida de Bs 1000");

  // Saldo después
  const saldoRes = RepoFondoReserva.saldo(cond.id);
  Logger.log("Saldo: Bs " + saldoRes.bs + ", USD " + saldoRes.usd + ", Total Bs " + saldoRes.bs_equivalente);
  Logger.log("  (esperado: Bs 1100, USD 50, equiv Bs ~2955)");

  // Tope por evento
  const tope = RepoFondoReserva.verificarTope(cond.id, 5000);
  Logger.log("¿Puede sacar Bs 5000? " + (tope.ok ? "SÍ" : "NO") + " (" + (tope.motivo || "") + ")");

  const tope2 = RepoFondoReserva.verificarTope(cond.id, 500);
  Logger.log("¿Puede sacar Bs 500? " + (tope2.ok ? "SÍ" : "NO"));

  // ============================================================
  // AUDITORÍA
  // ============================================================
  Logger.log("\n--- AUDITORÍA (verificar triggers) ---");
  const aud = sb.select("auditoria",
    "entidad=in.(movimientos_fondo_operativo,movimientos_fondo_reserva)" +
    "&condominio_id=eq." + cond.id +
    "&select=entidad,accion");
  Logger.log("Registros de auditoría de fondos: " + aud.length);
  Logger.log("  (esperado: 4 operativos + 5 reserva = 9)");

  // Limpieza (soft)
  RepoCondominios.eliminar(cond.id);
  Logger.log("\nTest finalizado. Datos quedan en BD.");

  Logger.log("\n=== TEST FINALIZADO ===");
}


function testFondoConTasa() {
  Logger.log("=== TEST Fondo con Tasa BCV ===");

  // Buscar el condominio del test anterior
  const cond = RepoCondominios.porNombre("Test Fondos Repo");
  if (!cond) {
    Logger.log("No existe el condominio de prueba.");
    return;
  }

  // Tasa actual
  const tasa = RepoTasasBCV.ultima();
  Logger.log("Tasa BCV: " + (tasa ? tasa.tasa : "NO HAY"));

  // Saldo del fondo de reserva
  const saldo = RepoFondoReserva.saldo(cond.id);
  Logger.log("Saldo Bs: " + saldo.bs);
  Logger.log("Saldo USD: " + saldo.usd);
  Logger.log("Equivalente Bs: " + saldo.bs_equivalente);
  Logger.log("  (esperado: Bs 1100 + 50*37.10 = 2955)");

  // Tope ahora con la tasa aplicada
  const tope500 = RepoFondoReserva.verificarTope(cond.id, 500);
  Logger.log("¿Puede sacar Bs 500? " + (tope500.ok ? "SÍ" : "NO"));
  Logger.log("Tope actual: Bs " + tope500.tope.toFixed(2));

  // Limpieza
  RepoCondominios.eliminar(cond.id);
  Logger.log("\n=== FIN ===");
}
