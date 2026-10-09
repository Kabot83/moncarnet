package fr.kabot83.moncarnet;

import android.graphics.Color;
import android.view.View;
import android.view.Window;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Accorde les barres système au thème de Mon Carnet : fond identique à celui
 * de l'application, icônes sombres sur fond clair et claires sur fond sombre.
 */
@CapacitorPlugin(name = "MonCarnetUi")
public class MonCarnetUiPlugin extends Plugin {

    @PluginMethod
    public void setTheme(PluginCall call) {
        boolean dark = Boolean.TRUE.equals(call.getBoolean("dark", false));
        String color = call.getString("color", dark ? "#1B1916" : "#F7F2EA");
        getBridge().executeOnMainThread(() -> {
            Window window = getActivity().getWindow();
            View decor = window.getDecorView();
            try {
                decor.setBackgroundColor(Color.parseColor(color));
            } catch (IllegalArgumentException ignored) {
                // Couleur invalide : on garde le fond du thème.
            }
            WindowInsetsControllerCompat controller = WindowCompat.getInsetsController(window, decor);
            controller.setAppearanceLightStatusBars(!dark);
            controller.setAppearanceLightNavigationBars(!dark);
            call.resolve();
        });
    }
}
