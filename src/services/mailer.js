const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.MAIL_USER,
    pass: process.env.MAIL_PASS,
  },
});

const wrapEmail = (contenido) => `
  <div style="background:#F3EFE9;padding:40px 16px;font-family:'Segoe UI',Arial,sans-serif">
    <div style="max-width:480px;margin:auto;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(92,61,46,0.12)">
      <div style="background:linear-gradient(135deg,#5C3D2E,#8B5E3C);padding:28px 32px;text-align:center">
        <span style="font-size:26px;letter-spacing:1px;color:#fff;font-weight:700">☕ SICABER</span>
      </div>
      <div style="padding:36px 32px">
        ${contenido}
      </div>
      <div style="background:#FAF7F3;padding:18px 32px;text-align:center;border-top:1px solid #EFE7DD">
        <p style="margin:0;color:#B0A392;font-size:11.5px">Este es un correo automático, por favor no lo respondas.</p>
      </div>
    </div>
  </div>
`;

const tokenBlock = (token) => `
  <div style="text-align:center;margin:28px 0 8px">
    <table role="presentation" align="center" style="border-collapse:separate;margin:auto">
      <tr>
        ${token.split('').map(d => `
          <td style="padding:0 4px">
            <div style="width:42px;height:52px;background:#FFF8F0;border:2px solid #D4A96A;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:800;color:#5C3D2E;font-family:'Courier New',monospace;line-height:52px;text-align:center">
              ${d}
            </div>
          </td>
        `).join('')}
      </tr>
    </table>
  </div>
  <p style="text-align:center;color:#B08A5A;font-size:11.5px;font-weight:600;letter-spacing:.5px;margin:12px 0 0">EXPIRA EN 15 MINUTOS</p>
`;

const enviarTokenRegistro = async (correo, nombre, token) => {
  await transporter.sendMail({
    from: `"SICABER ☕" <${process.env.MAIL_USER}>`,
    to: correo,
    subject: '✅ Confirma tu registro en SICABER',
    html: wrapEmail(`
      <h2 style="color:#5C3D2E;margin:0 0 6px;font-size:21px">¡Hola, ${nombre}! 👋</h2>
      <p style="color:#6B5A4E;font-size:14.5px;line-height:1.5;margin:0 0 4px">
        Gracias por registrarte en <strong>SICABER</strong>. Usa este código para confirmar tu cuenta:
      </p>
      ${tokenBlock(token)}
      <p style="color:#A69A8C;font-size:12.5px;margin:28px 0 0;line-height:1.5">
        Si no te registraste en SICABER, puedes ignorar este correo con tranquilidad.
      </p>
    `),
  });
};

const enviarTokenRecuperacion = async (correo, nombre, token) => {
  await transporter.sendMail({
    from: `"SICABER ☕" <${process.env.MAIL_USER}>`,
    to: correo,
    subject: '🔐 Recupera tu contraseña en SICABER',
    html: wrapEmail(`
      <h2 style="color:#5C3D2E;margin:0 0 6px;font-size:21px">Recuperar contraseña 🔐</h2>
      <p style="color:#6B5A4E;font-size:14.5px;line-height:1.5;margin:0 0 4px">
        Hola <strong>${nombre}</strong>, recibimos una solicitud para restablecer tu contraseña. Usa este código:
      </p>
      ${tokenBlock(token)}
      <p style="color:#A69A8C;font-size:12.5px;margin:28px 0 0;line-height:1.5">
        Si tú no solicitaste este cambio, ignora este correo; tu contraseña seguirá siendo la misma.
      </p>
    `),
  });
};

module.exports = { enviarTokenRegistro, enviarTokenRecuperacion };