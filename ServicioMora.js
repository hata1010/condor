// ============================================================
// SERVICIO — MORA
// Detecta cuotas vencidas, marca su estado y calcula intereses
// según los parámetros del condominio.
//
// Reglas:
// - Vencida si fecha_vencimiento + días_gracia < hoy
// - Mora = monto_pendiente × (tasa/100) × (días/30)
// - Si mora_congelar = true, los días se limitan a 90 (3 meses)
// ============================================================

const ServicioMora = {

  // ============================================================
  // ACTUALIZAR MORA DEL CONDOMINIO
  // Detecta cuotas vencidas, actualiza estados y calcula intereses
  // ============================================================
  actualizarMoraDelCondominio: function(condominioId) {
    if (!condominioId) throw new Error("Falta condominioId");

    // 1. Parámetros del condominio
    const params = RepoParametrosCondominio.porCondominio(condominioId);
    if (!params) throw new Error("No hay parámetros configurados para el condominio.");

    const diasGracia = parseInt(params.mora_dias_gracia) || 15;
    const tasaMensual = parseFloat(params.mora_tasa_mensual) || 3.00;
    const congelar = params.mora_congelar === true;
    const mesesNotificar = parseInt(params.mora_notificar_a_meses) || 3;

    const hoy = new Date();
    hoy.setHours(0, 0, 0, 0);
    const fechaHoy = this._formatearFecha_(hoy);

    // 2. Obtener cuotas pendientes/parciales/vencidas del condominio
    const cuotas = this._listarCuotasPorCobrar_(condominioId);

    const resultado = {
      analizadas: cuotas.length,
      marcadasVencidas: 0,
      interesesActualizados: 0,
      cuotasConMora: 0,
      totalIntereses: 0,
      detalle: []
    };

    // 3. Procesar cada cuota
    cuotas.forEach(cuota => {
      const fechaVenc = new Date(cuota.fecha_vencimiento + "T00:00:00");
      const fechaLimite = new Date(fechaVenc);
      fechaLimite.setDate(fechaLimite.getDate() + diasGracia);

      // ¿Ya venció con gracia?
      if (fechaLimite >= hoy) return; // aún dentro del plazo

      // Días de mora
      const diffMs = hoy.getTime() - fechaVenc.getTime();
      const diasMora = Math.floor(diffMs / (1000 * 60 * 60 * 24));

      // Saldo pendiente
      const saldoPendiente = parseFloat(cuota.saldo);
      if (saldoPendiente <= 0.01) return; // ya está cubierta

      // Marcar como VENCIDA si no lo está
      if (cuota.estado !== "VENCIDA") {
        RepoCuotas.marcarVencida(cuota.id);
        resultado.marcadasVencidas++;
      }

      // Calcular interés
      const interes = this._calcularInteres_(saldoPendiente, tasaMensual, diasMora, congelar);

      // ¿Ya existe un cálculo reciente para esta cuota?
      const yaExiste = this._existeCalculoHoy_(cuota.id, fechaHoy);
      if (yaExiste) {
        // Actualizar el cálculo de hoy (en lugar de crear duplicado)
        this._actualizarCalculoHoy_(cuota.id, fechaHoy, {
          monto: interes,
          tasa_aplicada: tasaMensual,
          dias_mora: diasMora
        });
      } else {
        // Crear cálculo nuevo
        RepoInteresesMora.registrar(cuota.id, interes, tasaMensual, diasMora);
      }

      resultado.interesesActualizados++;
      resultado.totalIntereses += interes;
      resultado.cuotasConMora++;

      if (resultado.detalle.length < 20) {
        resultado.detalle.push({
          cuotaId: cuota.id,
          concepto: cuota.concepto,
          saldoPendiente: saldoPendiente,
          diasMora: diasMora,
          interes: interes,
          congelado: congelar && diasMora > 90
        });
      }
    });

    resultado.totalIntereses = Math.round(resultado.totalIntereses * 100) / 100;

    return {
      exito: true,
      resumen: resultado,
      mensaje: "✅ " + resultado.marcadasVencidas + " marcada(s) vencida(s), " +
               resultado.interesesActualizados + " interés(es) actualizado(s). " +
               "Total intereses: Bs " + resultado.totalIntereses
    };
  },

  // ============================================================
  // CONSULTAS
  // ============================================================

  /**
   * Estado de cuenta con mora de un inmueble.
   */
  estadoCuentaConMora: function(inmuebleId) {
    if (!inmuebleId) throw new Error("Falta inmuebleId");

    const cuotas = RepoCuotas.listarPorInmueble(inmuebleId);
    const hoy = new Date();
    const hoyStr = this._formatearFecha_(hoy);

    // Parámetros del condominio (para mostrar tasa actual)
    const inm = RepoInmuebles.porId(inmuebleId);
    if (!inm) throw new Error("Inmueble no encontrado");
    const edfRes = sb.select("edificios", "id=eq." + inm.edificio_id);
    const condominioId = edfRes[0].condominio_id;
    const params = RepoParametrosCondominio.porCondominio(condominioId);

    const cuotasConMora = cuotas.map(c => {
      const fechaVenc = new Date(c.fecha_vencimiento + "T00:00:00");
      const diffMs = hoy.getTime() - fechaVenc.getTime();
      const diasMora = Math.max(0, Math.floor(diffMs / (1000 * 60 * 60 * 24)));

      let interesAcumulado = 0;
      let diasEfectivos = 0;

      if (c.estado === "VENCIDA" || c.estado === "PARCIAL") {
        const detalles = RepoInteresesMora.listarPorCuota(c.id);
        // Tomar el último cálculo (el más reciente)
        if (detalles.length) {
          interesAcumulado = parseFloat(detalles[0].monto);
          diasEfectivos = parseInt(detalles[0].dias_mora);
        }
      }

      return {
        concepto: c.concepto,
        monto: parseFloat(c.monto_original),
        pagado: parseFloat(c.monto_pagado),
        saldo: parseFloat(c.saldo),
        estado: c.estado,
        fechaVencimiento: c.fecha_vencimiento,
        diasMora: diasMora,
        diasEfectivos: diasEfectivos,
        interesMora: interesAcumulado,
        totalConMora: Math.round((parseFloat(c.saldo) + interesAcumulado) * 100) / 100
      };
    });

    const totalSaldo = cuotasConMora.reduce((s, c) => s + c.saldo, 0);
    const totalInteres = cuotasConMora.reduce((s, c) => s + c.interesMora, 0);

    return {
      inmueble: inm.codigo,
      cuotas: cuotasConMora,
      totalSaldo: Math.round(totalSaldo * 100) / 100,
      totalInteres: Math.round(totalInteres * 100) / 100,
      totalDeuda: Math.round((totalSaldo + totalInteres) * 100) / 100,
      tasaActual: params ? parseFloat(params.mora_tasa_mensual) : null,
      congelar: params ? params.mora_congelar : null
    };
  },

  /**
   * Lista cuotas con mora del condominio, ordenadas por días.
   */
  cuotasEnMora: function(condominioId) {
    if (!condominioId) throw new Error("Falta condominioId");

    const cuotas = this._listarCuotasPorCobrar_(condominioId);
    const hoy = new Date();

    return cuotas
      .filter(c => c.estado === "VENCIDA" || c.estado === "PARCIAL")
      .map(c => {
        const fechaVenc = new Date(c.fecha_vencimiento + "T00:00:00");
        const diasMora = Math.floor((hoy - fechaVenc) / (1000 * 60 * 60 * 24));
        const detalles = RepoInteresesMora.listarPorCuota(c.id);
        const interesActual = detalles.length ? parseFloat(detalles[0].monto) : 0;

        return {
          cuotaId: c.id,
          inmuebleId: c.inmueble_id,
          concepto: c.concepto,
          saldo: parseFloat(c.saldo),
          diasMora: diasMora,
          interesMora: interesActual,
          totalConMora: Math.round((parseFloat(c.saldo) + interesActual) * 100) / 100
        };
      })
      .sort((a, b) => b.diasMora - a.diasMora);
  },

  /**
   * Saldo total con mora de un inmueble (saldo + intereses).
   */
  saldoConMora: function(inmuebleId) {
    const estado = this.estadoCuentaConMora(inmuebleId);
    return {
      saldo: estado.totalSaldo,
      interes: estado.totalInteres,
      total: estado.totalDeuda
    };
  },

  // ============================================================
  // HELPERS PRIVADOS
  // ============================================================

  /**
   * Cuotas PENDIENTE, PARCIAL o VENCIDA del condominio.
   */
  _listarCuotasPorCobrar_: function(condominioId) {
    // Obtener inmuebles del condominio
    const inmuebles = RepoInmuebles.listarConEdificio(condominioId);
    if (!inmuebles.length) return [];

    const inmIds = inmuebles.map(i => i.id).join(",");

    return sb.select("cuotas",
      "inmueble_id=in.(" + inmIds + ")" +
      "&estado=in.(PENDIENTE,PARCIAL,VENCIDA)" +
      "&order=fecha_vencimiento.asc");
  },

  /**
   * Cálculo puro del interés.
   */
  _calcularInteres_: function(monto, tasa, dias, congelar) {
    if (dias <= 0) return 0;
    const diasEfectivos = congelar ? Math.min(dias, 90) : dias;
    const interes = monto * (tasa / 100) * (diasEfectivos / 30);
    return Math.round(interes * 100) / 100;
  },

  /**
   * ¿Ya hay un cálculo de mora para hoy en esta cuota?
   */
  _existeCalculoHoy_: function(cuotaId, fechaHoy) {
    const res = sb.select("intereses_mora",
      "cuota_id=eq." + cuotaId + "&fecha_calculo=eq." + fechaHoy + "&limit=1");
    return res && res.length > 0;
  },

  /**
   * Actualiza el cálculo de hoy si ya existe.
   */
  _actualizarCalculoHoy_: function(cuotaId, fechaHoy, cambios) {
    sb.update("intereses_mora",
      "cuota_id=eq." + cuotaId + "&fecha_calculo=eq." + fechaHoy,
      cambios);
  },

  _formatearFecha_: function(fecha) {
    const y = fecha.getFullYear();
    const m = String(fecha.getMonth() + 1).padStart(2, "0");
    const d = String(fecha.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + d;
  }

};


// ============================================================
// TEST — ServicioMora
// ============================================================
function testServicioMora() {
  Logger.log("=== TEST ServicioMora ===");

  const nombreTest = "Test Servicio Mora";

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
    sb.delete("auditoria", "condominio_id=eq." + condId);
    inmIds.forEach(iid => sb.delete("inmuebles", "id=eq." + iid));
    edfIds.forEach(eid => sb.delete("edificios", "id=eq." + eid));
    sb.delete("condominios", "id=eq." + condId);
  })();

  // ----------------------------------------------------------
  // SETUP
  // ----------------------------------------------------------
  Logger.log("\n--- Setup ---");
  const cond = RepoCondominios.crear({ nombre: nombreTest, email: "test@mora.com" });
  const edf = RepoEdificios.crear({ condominio_id: cond.id, nombre: "Edf Test", orden: 1 });
  const inm = RepoInmuebles.crear({ edificio_id: edf.id, codigo: "1-A", alicuota: 5.0 });
  const per = RepoPeriodosFiscales.crear({
    condominio_id: cond.id, anio: 2026,
    desde: "2026-01-01", hasta: "2026-12-31", estado: "ABIERTO"
  });
  RepoParametrosCondominio.crearConDefaults(cond.id);
  Logger.log("Setup OK");

  // ----------------------------------------------------------
  // CREAR CUOTAS CON DISTINTOS VENCIMIENTOS
  // ----------------------------------------------------------
  Logger.log("\n--- Cuotas con distintos vencimientos ---");

  const hoy = new Date();
  const fechaHoy = hoy.toISOString().substring(0, 10);
  const hace5 = new Date(hoy); hace5.setDate(hace5.getDate() - 5);
  const hace20 = new Date(hoy); hace20.setDate(hace20.getDate() - 20);
  const hace60 = new Date(hoy); hace60.setDate(hace60.getDate() - 60);
  const hace120 = new Date(hoy); hace120.setDate(hace120.getDate() - 120);

  const fmt = d => d.toISOString().substring(0, 10);

  // Cuota 1: vence hace 5 días → dentro de gracia (15) → sin mora
  const c1 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota hace 5 días", monto_original: 500,
    fecha_emision: fmt(hace5), fecha_vencimiento: fmt(hace5),
    estado: "PENDIENTE"
  });

  // Cuota 2: vence hace 20 días → vencida, 5 días de mora (20-15)
  const c2 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota hace 20 días", monto_original: 500,
    fecha_emision: fmt(hace20), fecha_vencimiento: fmt(hace20),
    estado: "PENDIENTE"
  });

  // Cuota 3: vence hace 60 días → vencida, 45 días de mora
  const c3 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota hace 60 días", monto_original: 1000,
    fecha_emision: fmt(hace60), fecha_vencimiento: fmt(hace60),
    estado: "PENDIENTE"
  });

  // Cuota 4: vence hace 120 días → vencida + congelada (90 días máximo)
  const c4 = RepoCuotas.crear({
    inmueble_id: inm.id, periodo_fiscal_id: per.id, tipo: "ORDINARIA",
    concepto: "Cuota hace 120 días", monto_original: 1000,
    fecha_emision: fmt(hace120), fecha_vencimiento: fmt(hace120),
    estado: "PENDIENTE"
  });

  Logger.log("4 cuotas creadas");

  // ----------------------------------------------------------
  // 1. ACTUALIZAR MORA
  // ----------------------------------------------------------
  Logger.log("\n--- 1. Actualizar mora ---");
  const r1 = ServicioMora.actualizarMoraDelCondominio(cond.id);
  Logger.log("Analizadas: " + r1.resumen.analizadas);
  Logger.log("Marcadas vencidas: " + r1.resumen.marcadasVencidas + " (esperado: 3)");
  Logger.log("Cuotas con mora: " + r1.resumen.cuotasConMora + " (esperado: 3)");
  Logger.log("Total intereses: Bs " + r1.resumen.totalIntereses);
  Logger.log("Detalle:");
  r1.resumen.detalle.forEach(d => {
    Logger.log("  " + d.concepto + " | " + d.diasMora + "d | interés Bs " + d.interes +
               (d.congelado ? " [CONGELADO]" : ""));
  });

  // ----------------------------------------------------------
  // 2. VERIFICAR ESTADOS DE CUOTAS
  // ----------------------------------------------------------
  Logger.log("\n--- 2. Estados de cuotas ---");
  [c1, c2, c3, c4].forEach((c, i) => {
    const actual = RepoCuotas.porId(c.id);
    Logger.log("Cuota " + (i+1) + ": " + actual.estado);
  });

  // ----------------------------------------------------------
  // 3. ESTADO DE CUENTA CON MORA
  // ----------------------------------------------------------
  Logger.log("\n--- 3. Estado de cuenta con mora ---");
  const estado = ServicioMora.estadoCuentaConMora(inm.id);
  Logger.log("Inmueble: " + estado.inmueble);
  Logger.log("Total saldo: Bs " + estado.totalSaldo);
  Logger.log("Total interés: Bs " + estado.totalInteres);
  Logger.log("Total deuda: Bs " + estado.totalDeuda);

  // ----------------------------------------------------------
  // 4. CUOTAS EN MORA
  // ----------------------------------------------------------
  Logger.log("\n--- 4. Cuotas en mora ---");
  const enMora = ServicioMora.cuotasEnMora(cond.id);
  Logger.log("Total: " + enMora.length);
  enMora.forEach(c => {
    Logger.log("  " + c.concepto + " | " + c.diasMora + "d | saldo " + c.saldo +
               " + interés " + c.interesMora + " = " + c.totalConMora);
  });

  // ----------------------------------------------------------
  // 5. IDEMPOTENCIA — correr de nuevo no debe duplicar
  // ----------------------------------------------------------
  Logger.log("\n--- 5. Correr de nuevo (idempotencia) ---");
  const r2 = ServicioMora.actualizarMoraDelCondominio(cond.id);
  Logger.log("Marcadas vencidas: " + r2.resumen.marcadasVencidas + " (esperado: 0)");
  Logger.log("Intereses actualizados: " + r2.resumen.interesesActualizados + " (esperado: 3)");

  // Verificar que no haya cálculos duplicados de hoy
  const calculosHoy = sb.select("intereses_mora",
    "fecha_calculo=eq." + fechaHoy + "&select=cuota_id");
  const cuotasUnicas = new Set(calculosHoy.map(c => c.cuota_id));
  Logger.log("Cuotas con cálculo hoy: " + cuotasUnicas.size + " (esperado: 3, sin duplicados)");

  // ----------------------------------------------------------
  // LIMPIEZA
  // ----------------------------------------------------------
  Logger.log("\n--- Limpieza ---");
  RepoCondominios.eliminar(cond.id);
  Logger.log("Test finalizado");

  Logger.log("\n=== TEST FINALIZADO ===");
}