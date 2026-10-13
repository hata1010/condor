// ============================================================
// MOTOR 1 — Groq Vision (lectura de comprobantes y facturas)
// ============================================================

function analizarComprobanteBancario(base64, mimeType) {
  const prompt = 'Analiza esta imagen de un comprobante bancario venezolano. ' +
    'Responde SOLO con JSON válido, sin texto adicional: ' +
    '{"es_comprobante":true,"banco":"","referencia":"","monto":0,"fecha":"DD/MM/AAAA"}. ' +
    'Si la imagen NO es un comprobante bancario, devuelve {"es_comprobante":false}. ' +
    'El campo "monto" debe ser número sin símbolos. ' +
    'El campo "referencia" es el número de referencia de la transferencia o pago móvil. ' +
    'El campo "banco" es el nombre del banco emisor.';

  return llamarGroqVision_(base64, mimeType, prompt);
}

function analizarFacturaGasto(base64, mimeType) {
  const prompt = 'Analiza esta imagen de una factura o recibo venezolano. ' +
    'Responde SOLO con JSON válido, sin texto adicional: ' +
    '{"es_comprobante":true,"proveedor":"","referencia":"","monto":0,"fecha":"DD/MM/AAAA","descripcion":""}. ' +
    'Si la imagen NO es una factura o recibo, devuelve {"es_comprobante":false}.';

  return llamarGroqVision_(base64, mimeType, prompt);
}

function llamarGroqVision_(base64, mimeType, promptTexto) {
  try {
    if (!base64 || typeof base64 !== "string") {
      return { error: "No se recibió la imagen." };
    }

    const dataUrl = base64.indexOf("data:") === 0
      ? base64
      : "data:" + (mimeType || "image/jpeg") + ";base64," + base64;

    const payload = {
     // model: "meta-llama/llama-4-scout-17b-16e-instruct",
      model: "qwen/qwen3.8-27b",
      messages: [{
        role: "user",
        content: [

          { type: "text", text: promptTexto },
          { type: "image_url", image_url: { url: dataUrl } }
        ]
      }],
      temperature: 0.1,
      max_tokens: 500,
      response_format: { type: "json_object" }
    };

    const props = PropertiesService.getScriptProperties();
    const apiKey = props.getProperty("GROQ_KEY");
    if (!apiKey) return { error: "Falta GROQ_KEY en PropertiesService." };

    const res = UrlFetchApp.fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "post",
      contentType: "application/json",
      headers: { Authorization: "Bearer " + apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    const json = JSON.parse(res.getContentText());
    if (json.error) return { error: "Groq: " + (json.error.message || "desconocido") };
    if (!json.choices || !json.choices[0]) return { error: "Respuesta inválida de Groq." };

    const contenido = JSON.parse(json.choices[0].message.content);
    if (contenido.es_comprobante === false) {
      return { error: "La imagen no corresponde a un comprobante bancario válido." };
    }
    return contenido;

  } catch (e) {
    return { error: "Error interno: " + e.message };
  }
}
