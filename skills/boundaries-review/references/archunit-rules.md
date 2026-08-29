# ArchUnit rules for a hexagonal service

Drop this into `src/test/java/.../architecture/ArchitectureTest.java`, adjust the base
package, and the layering stops being a convention. Rules are ordered by how often they
catch something real.

```java
package com.example.payments.architecture;

import com.tngtech.archunit.core.importer.ImportOption;
import com.tngtech.archunit.junit.AnalyzeClasses;
import com.tngtech.archunit.junit.ArchTest;
import com.tngtech.archunit.lang.ArchRule;

import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.classes;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.fields;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.methods;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noClasses;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noFields;
import static com.tngtech.archunit.lang.syntax.ArchRuleDefinition.noMethods;
import static com.tngtech.archunit.library.Architectures.layeredArchitecture;
import static com.tngtech.archunit.library.GeneralCodingRules.NO_CLASSES_SHOULD_ACCESS_STANDARD_STREAMS;
import static com.tngtech.archunit.library.GeneralCodingRules.NO_CLASSES_SHOULD_USE_FIELD_INJECTION;

@AnalyzeClasses(
        packages = "com.example.payments",
        importOptions = ImportOption.DoNotIncludeTests.class)
class ArchitectureTest {

    // ---------------------------------------------------------------- layering

    @ArchTest
    static final ArchRule layers_are_respected = layeredArchitecture()
            .consideringOnlyDependenciesInLayers()
            .layer("api").definedBy("..api..")
            .layer("application").definedBy("..application..")
            .layer("domain").definedBy("..domain..")
            .layer("infrastructure").definedBy("..infrastructure..")

            .whereLayer("api").mayNotBeAccessedByAnyLayer()
            .whereLayer("infrastructure").mayNotBeAccessedByAnyLayer()
            .whereLayer("application").mayOnlyBeAccessedByLayers("api", "infrastructure")
            .whereLayer("domain").mayOnlyBeAccessedByLayers("api", "application", "infrastructure");

    // ------------------------------------------------- the domain owes nothing

    @ArchTest
    static final ArchRule domain_has_no_framework_dependency = noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAnyPackage(
                    "org.springframework..",
                    "jakarta.persistence..",
                    "jakarta.validation..",
                    "com.fasterxml.jackson..",
                    "software.amazon.awssdk..",
                    "org.hibernate..")
            .because("the domain must compile and be testable without any framework");

    @ArchTest
    static final ArchRule domain_does_not_depend_on_infrastructure = noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAPackage("..infrastructure..");

    @ArchTest
    static final ArchRule domain_does_not_depend_on_generated_dtos = noClasses()
            .that().resideInAPackage("..domain..")
            .should().dependOnClassesThat().resideInAPackage("..api.dto..")
            .because("generated contract types must not leak past the boundary");

    // ------------------------------------------------------------- transactions

    @ArchTest
    static final ArchRule transactions_are_opened_in_the_application_layer = methods()
            .that().areAnnotatedWith("org.springframework.transaction.annotation.Transactional")
            .should().beDeclaredInClassesThat().resideInAPackage("..application..")
            .because("one transaction per use case, owned by the layer that owns the use case");

    // The rule above only sees method-level annotations. @Transactional on the class is
    // the more common form on a service or a repository, and it would pass unnoticed.
    @ArchTest
    static final ArchRule transactional_classes_live_in_the_application_layer = noClasses()
            .that().areAnnotatedWith("org.springframework.transaction.annotation.Transactional")
            .should().resideOutsideOfPackage("..application..")
            .because("a class-level @Transactional in infrastructure opens one transaction "
                    + "per statement, and no invariant spans them");

    @ArchTest
    static final ArchRule controllers_are_not_transactional = noClasses()
            .that().areAnnotatedWith("org.springframework.web.bind.annotation.RestController")
            .should().beAnnotatedWith("org.springframework.transaction.annotation.Transactional");

    // ------------------------------------------------------------------ access

    @ArchTest
    static final ArchRule repositories_are_reached_through_ports = noClasses()
            .that().resideInAPackage("..api..")
            .should().dependOnClassesThat().haveSimpleNameEndingWith("Repository")
            .because("a controller that reads the database skips the layer holding the invariants");

    @ArchTest
    static final ArchRule ports_live_inside = classes()
            .that().haveSimpleNameEndingWith("Port")
            .should().resideInAnyPackage("..domain..", "..application..")
            .because("a port declared outside is not an inverted dependency");

    // -------------------------------------------------------------- hygiene

    @ArchTest
    static final ArchRule no_field_injection = NO_CLASSES_SHOULD_USE_FIELD_INJECTION
            .because("constructor injection keeps dependencies visible and objects testable");

    @ArchTest
    static final ArchRule no_public_mutable_static_fields = fields()
            .that().areStatic().and().arePublic()
            .should().beFinal();
    
    @ArchTest
    static final ArchRule no_standard_streams = NO_CLASSES_SHOULD_ACCESS_STANDARD_STREAMS
            .because("logs go through the logging pipeline, where masking is applied");
}
```

## Rules worth adding in a payment codebase

```java
    @ArchTest
    static final ArchRule no_floating_point_fields = noFields()
            .that().areDeclaredInClassesThat().resideInAnyPackage("..domain..", "..application..")
            .should().haveRawType(double.class)
            .orShould().haveRawType(float.class)
            .orShould().haveRawType(Double.class)
            .orShould().haveRawType(Float.class)
            .because("money is BigDecimal or minor units, never binary floating point");

    @ArchTest
    static final ArchRule no_floating_point_return_types = noMethods()
            .that().areDeclaredInClassesThat().resideInAnyPackage("..domain..", "..application..")
            .should().haveRawReturnType(double.class)
            .orShould().haveRawReturnType(float.class)
            .orShould().haveRawReturnType(Double.class)
            .orShould().haveRawReturnType(Float.class)
            .because("a getter returning double re-introduces the representation the "
                    + "field rule just excluded");

    @ArchTest
    static final ArchRule psp_sdks_stay_in_their_adapter = noClasses()
            .that().resideOutsideOfPackage("..infrastructure.psp..")
            .should().dependOnClassesThat().resideInAnyPackage(
                    "com.stripe..", "com.adyen..", "com.worldline..")
            .because("a PSP SDK type in the domain makes the sixth integration a rewrite");

    @ArchTest
    static final ArchRule card_types_do_not_leave_the_vault_adapter = noClasses()
            .that().resideOutsideOfPackage("..infrastructure.vault..")
            .should().dependOnClassesThat().areAnnotatedWith(
                    "com.example.payments.CardData")
            .because("card data must stop at the tokenization boundary");
```

The last one is the cheapest PCI-scope guard a Java codebase can have: a compile-time
fence around the types that carry the PAN. It catches the "just pass the card object
through for now" commit before review does.

It needs a marker to fence, and the marker has to be something the compiler holds rather
than something everyone remembers:

```java
@Retention(RetentionPolicy.CLASS)
@Target(ElementType.TYPE)
public @interface CardData {
}
```

Annotate every type that can hold a PAN, CVV or track data with it. An earlier version of
this rule matched `haveSimpleNameEndingWith("CardDetails")` instead. Do not do that: a
rule keyed on a naming convention protects only the classes someone thought to name
correctly, and nothing enforces the convention — which is the failure mode this whole
skill exists to point out. If you keep a name-based variant as a second net, keep it *as
well as* the annotation, never instead of it.

## Making it useful rather than annoying

- **Run it in the normal test phase.** An architecture test in a separate profile that
  CI skips is documentation.
- **`because(...)` on every rule.** The failure message is the only explanation the
  author will read; make it name the consequence.
- **Freeze on adoption.** For an existing codebase, `FreezingArchRule` records current
  violations and fails only on new ones, so the rule can land today instead of after a
  three-week cleanup:

```java
import com.tngtech.archunit.library.freeze.FreezingArchRule;

    @ArchTest
    static final ArchRule frozen = FreezingArchRule.freeze(domain_has_no_framework_dependency);
```

The frozen violations are stored in `archunit_store/`, which belongs in version control —
it is the record of the debt, and a reviewer should see it shrink.

- **Delete rules that never fire and never will.** A suite of forty rules nobody reads
  is a slower build with the authority of a comment.
