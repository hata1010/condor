// ============================================================
// SERVICIO — CONCILIACIÓN BANCARIA
// Cruza extracto bancario con pagos registrados.
// Al conciliar un pago, dispara ServicioPagos.conciliar()
// que aplica cuotas, alimenta fondos y crea saldos a favor.
// ============================================================

const ServicioConciliacion = {

  // ============================================================
  // CARGA DE EXTRACTO — parsea y guarda movimientos
  // ============================================================
  /**
   * Formato esperado por línea:
   *   Fecha | Referencia | Descripción | Monto [| Balance]
   * Separadores: tab, ; o ,
   */
  cargarExtracto: function(condominioId, textoPlano, banco) {
    if (!condominioId) throw new Error("Falta condominioId");
    if (!textoPlano || !textoPlano.trim()) throw new Error("No se recibió texto");

    // 1. Referencias existentes
    const existentes = sb.select("movimientos_banco",
      "condominio_id=eq." + condominioId + "&select=referencia");
    const refsExistentes = new Set(existentes.map(m => String(m.referencia).trim()));

    // 2. Parsear
    const lineas = textoPlano.split(/\r?\n/);
    const nuevas = [];
    const duplicadas = [];
    const errores = [];

    lineas.forEach((linea, i) => {
      if (!linea.trim()) return;
      const parsed = this.parsearLinea_(linea);
      if (!parsed) {
        errores.push("Línea " + (i + 1) + ": formato no reconocido");
        return;
      }

      const ref = String(parsed.referencia).trim();
      if (refsExistentes.has(ref)) {
        duplicadas.push(ref);
        return;
      }
      // Marcar como existente para no duplicar dentro del mismo lote
      refsExistentes.add(ref);

      nuevas.push({
        condominio_id: condominioId,
        banco: banco || null,
        fecha: parsed.fecha,
        referencia: ref,
        descripcion: parsed.descripcion,
        monto: parsed.monto,
        balance: parsed.balance,
        estado_conciliacion: "PENDIENTE"
      });
    });

    // 3. Insertar las nuevas
    if (nuevas.length) {
      RepoMovimientosBanco.crearLote(nuevas);
    }

    return {
      exito: true,
      nuevas: nuevas.length,
      duplicadas: duplicadas.length,
      errores: errores.length,
      erroresDetalle: errores.slice(0, 5),
      mensaje: "✅ " + nuevas.length + " movimiento(s) cargado(s). " +
               duplicadas.length + " duplicado(s). " +
               errores.length + " error(es)."
    };
  },

  // ============================================================
  // CONCILIACIÓN AUTOMÁTICA
  // ============================================================
  conciliarAutomaticamente: function(condominioId) {
    if (!condominioId) throw new Error("Falta condominioId");

    // 1. Movimientos pendientes del condominio
    const pendientes = RepoMovimientosBanco.listarPendientes(condominioId);

    const resultado = {
      conciliados: 0,
      huerfanos: 0,
      omitidos: 0,
      detalle: []
    };

    // 2. Para cada movimiento, buscar pago por referencia
    pendientes.forEach(mov => {
      const pago = RepoPagos.porReferencia(condominioId, mov.referencia);

      if (!pago) {
        // No hay pago → huérfano
        RepoMovimientosBanco.marcarHuerfano(mov.id, "Sin pago asociado");
        resultado.huerfanos++;
        resultado.detalle.push({
          referencia: mov.referencia,
          estado: "HUERFANO",
          motivo: "Sin pago registrado"
        });
        return;
      }

      // Hay pago. ¿Está ya conciliado?
      if (pago.estado === "CONCILIADO") {
        // Ya estaba conciliado, solo vinculamos
        RepoMovimientosBanco.conciliarConPago(mov.id, pago.id);
        resultado.omitidos++;
        resultado.detalle.push({
          referencia: mov.referencia,
          estado: "YA_CONCILIADO",
          motivo: "El pago ya estaba conciliado"
        });
        return;
      }

      // Verificar que los montos coincidan
      const montoMov = Math.abs(parseFloat(mov.monto));
      const montoPago = parseFloat(pago.monto_bs);
      const diferencia = Math.abs(montoMov - montoPago);

      if (diferencia > 0.01) {
        // Montos no coinciden → no conciliar automáticamente
        RepoMovimientosBanco.marcarHuerfano(
          mov.id,
          "Monto no coincide: banco Bs " + montoMov + " vs pago Bs " + montoPago
        );
        resultado.huerfanos++;
        resultado.detalle.push({
          referencia: mov.referencia,
          estado: "DIFERENCIA_MONTO",
          motivo: "Banco: Bs " + montoMov + " | Pago: Bs " + montoPago
        });
        return;
      }

      // Todo OK: conciliar el pago
      try {
        ServicioPagos.conciliar(pago.id, { modo: "FIFO" });
        RepoMovimientosBanco.conciliarConPago(mov.id, pago.id);
        resultado.conciliados++;
        resultado.detalle.push({
          referencia: mov.referencia,
          estado: "CONCILIADO",
          pagoId: pago.id,
          monto: montoMov
        });
      } catch (e) {
        // Error al conciliar → dejar huérfano con nota
        RepoMovimientosBanco.marcarHuerfano(mov.id, "Error al conciliar: " + e.message);
        resultado.huerfanos++;
        resultado.detalle.push({
          referencia: mov.referencia,
          estado: "ERROR_CONCILIACION",
          motivo: e.message
        });
      }
    });

    return {
      exito: true,
      resumen: resultado,
      mensaje: "✅ " + resultado.conciliados + " conciliado(s), " +
               resultado.huerfanos + " huérfano(s), " +
               resultado.omitidos + " omitido(s)."
    };
  },

  // ============================================================
  // CONCILIACIÓN MANUAL (override)
  // ============================================================
  conciliarManual: function(movimientoId, pagoId) {
    const mov = RepoMovimientosBanco.porId(movimientoId);
    if (!mov) throw new Error("Movimiento no encontrado");

    const pago = RepoPagos.porId(pagoId);
    if (!pago) throw new Error("Pago no encontrado");

    // Conciliar el pago si no lo está
    if (pago.estado !== "CONCILIADO") {
      ServicioPagos.conciliar(pagoId, { modo: "FIFO" });
    }

    // Vincular
    RepoMovimientosBanco.conciliarConPago(movimientoId, pagoId);

    return {
      exito: true,
      mensaje: "Movimiento " + mov.referencia + " conciliado con pago " + pago.referencia + "."
    };
  },

  // ============================================================
  // MARCAR IGNORADO (comisión bancaria, etc.)
  // ============================================================
  marcarIgnorado: function(movimientoId, nota) {
    const mov = RepoMovimientosBanco.porId(movimientoId);
    if (!mov) throw new Error("Movimiento no encontrado");

    RepoMovimientosBanco.marcarIgnorado(movimientoId, nota || "Ignorado manualmente");

    return { exito: true, mensaje: "Movimiento marcado como ignorado." };
  },

  // ============================================================
  // REPORTES
  // ============================================================
  listarHuerfanos: function(condominioId) {
    return RepoMovimientosBanco.listarHuerfanos(condominioId);
  },

  listarPendientes: function(condominioId) {
    return RepoMovimientosBanco.listarPendientes(condominioId);
  },

  /**
   * Resumen del estado de conciliación del condominio.
   */
  resumen: function(condominioId) {
    const todos = RepoMovimientosBanco.listarPorCondominio(condominioId);
    const conteo = {
      PENDIENTE: 0,
      CONCILIADO: 0,
      HUERFANO: 0,
      IGNORADO: 0
    };
    todos.forEach(m => {
      conteo[m.estado_conciliacion] = (conteo[m.estado_conciliacion] || 0) + 1;
    });

    return {
      total: todos.length,
      pendientes: conteo.PENDIENTE,
      conciliados: conteo.CONCILIADO,
      huerfanos: conteo.HUERFANO,
      ignorados: conteo.IGNORADO
    };
  },

  // ============================================================
  // PARSEO DE LÍNEA
  // ============================================================
  parsearLinea_: function(linea) {
    if (!linea || !linea.trim()) return null;

    // Detectar separador
    let sep = "\t";
    if (linea.indexOf("\t") === -1) {
      if (linea.indexOf(";") !== -1) sep = ";";
      else if (linea.split(",").length >= 4) sep = ",";
      else return null;
    }

    const partes = linea.split(sep).map(p => p.trim().replace(/^"|"$/g, ""));
    if (partes.length < 4) return null;

    // Fecha
    const fecha = this.parsearFecha_(partes[0]);
    if (!fecha) return null;

    // Referencia tal cual (sin transformar)
    const referencia = String(partes[1]).trim();

    // Descripción
    const descripcion = partes[2];

    // Monto
    const monto = this.parsearMonto_(partes[3]);
    if (monto === null) return null;

    // Balance (opcional)
    const balance = partes[4] ? this.parsearMonto_(partes[4]) : null;

    return { fecha, referencia, descripcion, monto, balance };
  },

  parsearFecha_: function(str) {
    if (!str) return null;
    str = str.trim();
    // YYYY-MM-DD
    let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return m[1] + "-" + m[2].padStart(2, "0") + "-" + m[3].padStart(2, "0");
    // DD/MM/YYYY o DD-MM-YYYY
    m = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
    if (m) {
      let anio = parseInt(m[3]);
      if (anio < 100) anio += 2000;
      return anio + "-" + m[2].padStart(2, "0") + "-" + m[1].padStart(2, "0");
    }
    return null;
  },

  parsearMonto_: function(str) {
    if (str === null || str === undefined) return null;
    let s = String(str).trim().replace(/[^\d,.\-]/g, "");
    if (!s) return null;
    // Formato 1.234,56
    if (/,\d{1,2}$/.test(s) && s.indexOf(".") !== -1) {
      s = s.replace(/\./g, "").replace(",", ".");
    } else {
      s = s.replace(/,/g, "");
    }
    const n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

};



// ============================================================
// TEST — ServicioConciliacion
// ============================================================
function testServicioConciliacion() {
  Logger.log("=== TEST ServicioConciliacion ===");

  const nombreTest = "Test Servicio Conciliacion";

  // Limpieza previa
  (function limpiar() {
    const prev = RepoCondominios.porNombre(nombreTest);
    if (!prev) return;
    const condId = prev.id;
    const edfs = sb.select("edificios", "condominio_id=eq." + condId);
    const edfIds = edfs.map(e => e.id);
    let inmIds = [];
    edfIds.forEach(eid => {
      sb.select("inmuebles", "edificio_id=eq." + eid).forEach(i => inmIds.push(i.id));
    });

    inmIds.forEach(iid => {
      const pagos = sb.select("pagos", "inmueble_id=eq." + iid);
      pagos.forEach(p => sb.delete("aplicaciones_pago", "pago_id=eq." + p.id));
      sb.delete("pagos", "inmueble_id=eq." + iid);
      sb.delete("saldos_favor", "inmueble_id=eq." + iid);
      const cuotas = sb.select("cuotas", "inmueble_id=eq." + iid);
      cuotas.forEach(c => {
        sb.delete("cuota_detalle", "cuota_id=eq." + c.id);
        sb.delete("aplicaciones_pago", "cuota_id=eq." + c.id);
        sb.delete("intereses_mora", "cuota_id=eq." + c.id);
      });
      sb.delete("cuotas", "inmueble_id=eq." + iid);
    });

    sb.delete("movimientos_banco", "condominio_id=eq." + condId);
    sb.delete("movimientos_fondo_operativo", "condominio_id=eq." + condId);
    sb.delete("movimientos_fondo_reserva", "condominio_id=eq." + condId);
    const egresos = sb.select("egresos", "condominio_id=eq." + condId);
    egresos.forEach(e => sb.delete("egreso_reparto", "egreso_id=eq." + e.id));
    sb.delete("egresos", "condominio_id=eq." + condId);
    sb.delete("categorias_gasto", "condominio_id=eq." + condId);
    sb.delete("parametros_condominio", "condominio_id=eq." + condId);
    sb.delete("parametros_fondo_reserva", "condominio_id=eq." + condId);
    sb.delete("cuotas_base", "condominio_id=eq." + condId);
    sb.delete("periodo_fiscal", "condominio_id=eq." + condId);
    inmIds.forEach(iid => sb.delete("inmuebles", "id=eq." + iid));
    edfIds.forEach(eid => sb.delete("edificios", "id=eq." + eid));
    sb.delete("condominios", "id=eq." + condId);
  })();

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({ nombre: nombreTest, email: "test@conc.com" });
  const edf = RepoEdificios.crear({ condominio_id: cond.id, nombre: "Edf Test", orden: 1 });
  const inm = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-A", alicuota: 5.0 });
  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id, anio: 2026,
    desde: "2026-01-01", hasta: "2026-12-31", estado: "ABIERTO"
  });
  RepoParametrosFondoReserva.crearConDefaults(cond.id);

  // Crear 3 cuotas pendientes
  const c1 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Oct", monto_original: 500,
    fecha_emision: "2026-10-01", fecha_vencimiento: "2026-10-15"
  });
  const c2 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Nov", monto_original: 500,
    fecha_emision: "2026-11-01", fecha_vencimiento: "2026-11-15"
  });
  const c3 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota Dic", monto_original: 500,
    fecha_emision: "2026-12-01", fecha_vencimiento: "2026-12-15"
  });
  Logger.log("3 cuotas de Bs 500 creadas");

  // Crear 2 pagos REGISTRADOS (sin conciliar)
  Logger.log("\n--- Registrar pagos (sin conciliar) ---");
  const pago1 = RepoPagos.crear({
    inmueble_id: inm.id,
    fecha_pago: "2026-10-05",
    monto: 800, moneda: "BS", monto_bs: 800,
    referencia: "REF-BANCO-001",
    banco: "Banesco",
    estado: "REGISTRADO"
  });
  Logger.log("Pago 1: " + pago1.referencia + " (Bs " + pago1.monto_bs + ")");

  const pago2 = RepoPagos.crear({
    inmueble_id: inm.id,
    fecha_pago: "2026-10-06",
    monto: 500, moneda: "BS", monto_bs: 500,
    referencia: "REF-BANCO-002",
    banco: "Banesco",
    estado: "REGISTRADO"
  });
  Logger.log("Pago 2: " + pago2.referencia + " (Bs " + pago2.monto_bs + ")");

  // ----------------------------------------------------------
  // 1. CARGAR EXTRACTO BANCARIO
  // ----------------------------------------------------------
  Logger.log("\n--- 1. Cargar extracto ---");
  const extracto = [
    "2026-10-05\tREF-BANCO-001\tPago Movil Condominio Apto 1-A\t800.00\t15000.00",
    "2026-10-06\tREF-BANCO-002\tPago Movil Condominio Apto 1-A\t500.00\t15500.00",
    "2026-10-07\tREF-BANCO-099\tComision bancaria\t-50.00\t15450.00",
    "2026-10-08\tREF-BANCO-100\tOtro pago sin registro\t1000.00\t16450.00"
  ].join("\n");

  const carga = ServicioConciliacion.cargarExtracto(cond.id, extracto, "Banesco");
  Logger.log("Nuevas: " + carga.nuevas);
  Logger.log("Duplicadas: " + carga.duplicadas);
  Logger.log("Errores: " + carga.errores);

  // ----------------------------------------------------------
  // 2. VER RESUMEN ANTES DE CONCILIAR
  // ----------------------------------------------------------
  Logger.log("\n--- 2. Resumen antes de conciliar ---");
  const r1 = ServicioConciliacion.resumen(cond.id);
  Logger.log("Total: " + r1.total);
  Logger.log("Pendientes: " + r1.pendientes);
  Logger.log("Conciliados: " + r1.conciliados);
  Logger.log("Huérfanos: " + r1.huerfanos);
  Logger.log("Ignorados: " + r1.ignorados);

  // ----------------------------------------------------------
  // 3. CONCILIAR AUTOMÁTICAMENTE
  // ----------------------------------------------------------
  Logger.log("\n--- 3. Conciliar automáticamente ---");
  const conc = ServicioConciliacion.conciliarAutomaticamente(cond.id);
  Logger.log("Conciliados: " + conc.resumen.conciliados);
  Logger.log("Huérfanos: " + conc.resumen.huerfanos);
  Logger.log("Omitidos: " + conc.resumen.omitidos);

  Logger.log("Detalle:");
  conc.resumen.detalle.forEach(d => {
    Logger.log("  " + d.referencia + " → " + d.estado + (d.motivo ? " (" + d.motivo + ")" : ""));
  });

  // ----------------------------------------------------------
  // 4. VERIFICAR ESTADO DE LOS PAGOS
  // ----------------------------------------------------------
  Logger.log("\n--- 4. Estado de los pagos ---");
  const p1 = RepoPagos.porId(pago1.id);
  const p2 = RepoPagos.porId(pago2.id);
  Logger.log("Pago 1: " + p1.estado);
  Logger.log("Pago 2: " + p2.estado);

  // ----------------------------------------------------------
  // 5. VERIFICAR CUOTAS Y FONDOS
  // ----------------------------------------------------------
  Logger.log("\n--- 5. Cuotas y fondos ---");
  const cuotas = sb.select("cuotas",
    "inmueble_id=eq." + inm.id + "&select=concepto,estado,monto_pagado,saldo");
  cuotas.forEach(c => {
    Logger.log("  " + c.concepto + ": " + c.estado + " (pagado " + c.monto_pagado + ", saldo " + c.saldo + ")");
  });

  const saldoOpe = RepoFondoOperativo.saldo(cond.id);
  const saldoRes = RepoFondoReserva.saldo(cond.id);
  Logger.log("Fondo operativo: Bs " + saldoOpe + " (esperado: 1170 = 1300*0.9)");
  Logger.log("Fondo reserva:   Bs " + saldoRes.bs + " (esperado: 130 = 1300*0.1)");

  // ----------------------------------------------------------
  // 6. RESULTADO FINAL
  // ----------------------------------------------------------
  Logger.log("\n--- 6. Resumen después de conciliar ---");
  const r2 = ServicioConciliacion.resumen(cond.id);
  Logger.log("Total: " + r2.total);
  Logger.log("Pendientes: " + r2.pendientes);
  Logger.log("Conciliados: " + r2.conciliados);
  Logger.log("Huérfanos: " + r2.huerfanos);
  Logger.log("Ignorados: " + r2.ignorados);

  // ----------------------------------------------------------
  // 7. IGNORAR LA COMISIÓN
  // ----------------------------------------------------------
  Logger.log("\n--- 7. Ignorar comisión bancaria ---");
  const huerfanos = ServicioConciliacion.listarHuerfanos(cond.id);
  const comision = huerfanos.find(h => h.referencia === "REF-BANCO-099");
  if (comision) {
    ServicioConciliacion.marcarIgnorado(comision.id, "Comisión bancaria");
    Logger.log("Comisión marcada como ignorada");
  }

  // ----------------------------------------------------------
  // 8. ANULAR PAGO 1 (reversión)
  // ----------------------------------------------------------
  Logger.log("\n--- 8. Anular pago 1 ---");
  const anul = ServicioPagos.anular(pago1.id, "Prueba de reversión");
  Logger.log(anul.mensaje);
  Logger.log("Fondo operativo después: Bs " + RepoFondoOperativo.saldo(cond.id));
  Logger.log("Fondo reserva después:   Bs " + RepoFondoReserva.saldo(cond.id).bs);

  // ----------------------------------------------------------
  // LIMPIEZA
  // ----------------------------------------------------------
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}