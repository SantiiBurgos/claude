package ar.gastos.app;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.util.ArrayList;
import java.util.List;

/**
 * Muestra la app web (la misma que se publica en GitHub Pages, así se actualiza sola)
 * y le agrega lo que una página no puede hacer: leer notificaciones de pago,
 * recibir archivos por "Compartir" y guardar archivos en el teléfono.
 */
public class MainActivity extends Activity {
    private static final String HOST = "santiiburgos.github.io";
    private static final String INICIO = "https://" + HOST + "/claude/gastos/";
    private static final int ELEGIR_ARCHIVO = 1;
    private static final String SIN_RED = "<html><meta name='viewport' content='width=device-width'>"
            + "<body style='font-family:sans-serif;background:#0f1110;color:#eef0ea;padding:48px 24px;text-align:center'>"
            + "<h2>Sin conexión</h2><p>La primera vez hace falta internet para bajar la app. Después funciona sin conexión.</p>"
            + "<p><a style='color:#b8f04a;font-size:18px' href='" + INICIO + "'>Reintentar</a></p></body></html>";

    private WebView web;
    private ValueCallback<Uri[]> archivos;
    private boolean lista;

    // Lo último que llegó por "Compartir"; la página lo pide a través de Puente.
    volatile boolean hayCompartido;
    volatile String compTexto = "";
    volatile String compMime = "";
    volatile byte[] compDatos;

    @Override
    protected void onCreate(Bundle guardado) {
        super.onCreate(guardado);
        web = new WebView(this);
        setContentView(web);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(false);
        s.setTextZoom(100);
        web.addJavascriptInterface(new Puente(this), "Android");

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (HOST.equals(u.getHost())) return false;
                if (!"https".equals(u.getScheme())) return true;
                // Cualquier otro sitio se abre en el navegador, no adentro de la app.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignorada) {
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                lista = true;
                avisarCompartido();
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest r, WebResourceError e) {
                if (r.isForMainFrame()) v.loadDataWithBaseURL(null, SIN_RED, "text/html", "utf-8", null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView v, ValueCallback<Uri[]> cb, FileChooserParams p) {
                if (archivos != null) archivos.onReceiveValue(null);
                archivos = cb;
                try {
                    startActivityForResult(selector(p.getAcceptTypes()), ELEGIR_ARCHIVO);
                } catch (Exception e) {
                    archivos = null;
                    return false;
                }
                return true;
            }
        });

        tomarCompartido();
        if (guardado == null) web.loadUrl(INICIO);
        else web.restoreState(guardado);
    }

    /** Arma el selector de archivos según lo que acepta el campo de la página. */
    private static Intent selector(String[] acepta) {
        List<String> tipos = new ArrayList<>();
        boolean cualquiera = false;
        if (acepta != null) {
            for (String lista : acepta) {
                if (lista == null) continue;
                // Según la versión de WebView, los tipos pueden venir separados o todos juntos con comas.
                for (String a : lista.split(",")) {
                    a = a.trim();
                    if (!a.contains("/")) continue;
                    // Los respaldos .json suelen venir con un tipo genérico: mejor dejar elegir cualquier archivo.
                    if (a.equals("application/json")) cualquiera = true;
                    tipos.add(a);
                }
            }
        }
        Intent i = new Intent(Intent.ACTION_GET_CONTENT);
        i.addCategory(Intent.CATEGORY_OPENABLE);
        if (cualquiera || tipos.isEmpty()) {
            i.setType("*/*");
        } else if (tipos.size() == 1) {
            i.setType(tipos.get(0));
        } else {
            i.setType("*/*");
            i.putExtra(Intent.EXTRA_MIME_TYPES, tipos.toArray(new String[0]));
        }
        return i;
    }

    @Override
    protected void onActivityResult(int pedido, int resultado, Intent datos) {
        super.onActivityResult(pedido, resultado, datos);
        if (pedido == ELEGIR_ARCHIVO && archivos != null) {
            archivos.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultado, datos));
            archivos = null;
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        tomarCompartido();
    }

    /** Toma lo que dejó CompartirActivity (si hay algo) para que la página lo pida. */
    private void tomarCompartido() {
        Compartido c = Compartido.tomar();
        if (c == null) return;
        compTexto = c.texto;
        compMime = c.mime;
        compDatos = c.datos;
        hayCompartido = true;
        avisarCompartido();
    }

    private void avisarCompartido() {
        if (lista && hayCompartido && web != null) web.evaluateJavascript("window.nativoCompartido&&window.nativoCompartido()", null);
    }

    @Override
    protected void onResume() {
        super.onResume();
        tomarCompartido();
        // Al volver a la app, que la página revise si hay movimientos nuevos detectados.
        if (lista) web.evaluateJavascript("window.nativoVolvio&&window.nativoVolvio()", null);
    }

    @Override
    public void onBackPressed() {
        // La página decide: cierra el formulario abierto o vuelve a Inicio; si no hay nada que cerrar, se minimiza.
        web.evaluateJavascript("(window.atras&&window.atras())===true", v -> {
            if (!"true".equals(v)) moveTaskToBack(true);
        });
    }

    @Override
    protected void onSaveInstanceState(Bundle salida) {
        super.onSaveInstanceState(salida);
        web.saveState(salida);
    }
}
