package kitchen.longtable.app;

import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Local plugin (not an npm package): the localhost API's native
        // socket half. Registered before super so the bridge knows it
        // when the web view starts asking.
        registerPlugin(LocalApiPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
