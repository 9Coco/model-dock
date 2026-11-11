import ai.grazie.llm.api.model.ChatModels;
import kotlinx.serialization.json.Json;
import java.lang.reflect.*;
import java.nio.file.*;
import java.util.*;

/** Public installed classes only; no IDE, credentials, settings or network. */
public class ReasoningSchemaProbe {
  public static void main(String[] args) throws Exception {
    if (args.length == 1) {
      int count = 0;
      for (String line : Files.readAllLines(Path.of(args[0]))) {
        String[] parts = line.split("\t", 2);
        var serializer = ChatModels.Stream.V9.Request.Companion.serializer();
        var request = Json.Default.decodeFromString(serializer, parts[1]);
        if (!parts[0].equals(request.getParameters().getReasoningEffort())) throw new AssertionError("Native effort decoder");
        var roundTrip = Json.Default.decodeFromString(serializer, Json.Default.encodeToString(serializer, request));
        if (!parts[0].equals(roundTrip.getParameters().getReasoningEffort())) throw new AssertionError("Native effort encoder");
        count++;
      }
      System.out.println("JETBRAINS_REASONING_SCHEMA_OK " + count);
      return;
    }
    Class<?> llm = Class.forName("com.intellij.ml.llm.matterhorn.llm.LLM");
    Class<?> effort = Class.forName("com.intellij.ml.llm.matterhorn.llm.EffortLevel");
    Object companion = effort.getField("Companion").get(null);
    Method available = companion.getClass().getMethod("availableForModel", llm);
    Method defaultLevel = companion.getClass().getMethod("defaultForModel", llm);
    Method wire = effort.getMethod("getWireId");
    Method id = Arrays.stream(llm.getMethods()).filter(m -> m.getName().startsWith("getJbai-")).findFirst().orElseThrow();
    for (Field field : llm.getDeclaredFields()) {
      if (field.getType() != llm || !Modifier.isStatic(field.getModifiers())) continue;
      field.setAccessible(true); Object model = field.get(null);
      List<String> levels = new ArrayList<>();
      for (Object level : (List<?>) available.invoke(companion, model)) levels.add((String) wire.invoke(level));
      System.out.println(id.invoke(model) + "\t" + llm.getMethod("getProvider").invoke(model) + "\t" + String.join(",", levels) + "\t" + wire.invoke(defaultLevel.invoke(companion, model)));
    }
  }
}
