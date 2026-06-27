#include <stdio.h>

extern int bla;
/*extern int bla2 = 4;*/ // invalid

int a = 3;

int b = 4, c = 5;

typedef unsigned int u32;
typedef int (*funcpointertype)(int, int);
typedef int functype(int, int);

int (*funcp)(int, int);

__typeof(funcp) fp2;
funcpointertype fp3;

functype f;
__typeof(f) f2;

typedef struct _NODE {
	u32 data;
	struct _NODE *prev;
	struct _NODE *next;
} NODE;

typedef struct _SOME {
	u32 somedata; 
} SOME;

typedef struct _COMP {
	u32 data;
	u32 arr[10];
	SOME someSt;
	NODE *ptrNode; 
} COMP;

typedef enum _STATE {
    READY,
    WORKING,
    PAUSED,
    SUSPEND = 99
} STATE;

void func1(NODE node, SOME some);
void func2(SOME some);
void func3(COMP comp);
void func4(STATE comp);
void func12(NODE* node_list, int count);  // ?�기 참조 구조�?depth 2 ?�용
void func13(COMP* comp_array, int size);  // 복잡??구조�?depth 2 ?�용
void func14(NODE* root, COMP* context);   // ?�합 구조�?depth 2 ?�용

int TD_main_0_0() 
{
  NODE node;
  SOME some;
  COMP comp; 
  STATE state;

  int a = 4;

  int b = a;

  c = 5;

  if(a > 10)
  {
	  b = 1;
	  c = a;
  }
  else
  {
	  ;
  }

  while(b < 10)
  {
	  b++;
  }

  do
  {
	  b++;
  }while(b < 100);

  func1(node, some);
  func2(some);
  func3(comp);
  func4(state);
  
  // ?�로??depth 2 ?�수???�출
  NODE node_array[3];
  COMP comp_array[2];
  func12(node_array, 3);
  func13(comp_array, 2);
  func14(&node, &comp);
}

void func1(NODE node, SOME some)
{
    printf("=== func1 ===\n");
    printf("Parameter node.data = %u\n", node.data);
    printf("Parameter some.somedata = %u\n", some.somedata);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: ?�드 ?�이?��? ?�역변?��? ?�용??계산
    if (node.data > 1000) {
        c = node.data % 100 + some.somedata;
        printf("Result: c = %d (node.data > 1000 condition)\n", c);
    } else {
        c = node.data + some.somedata + a;
        printf("Result: c = %d (node.data <= 1000 condition)\n", c);
    }
    
    // ?�역변??b ?�데?�트
    b = (b + node.data) % 50;
    printf("Updated b = %d\n", b);
}

void func2(SOME some)
{
    printf("=== func2 ===\n");
    printf("Parameter some.somedata = %u\n", some.somedata);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: some ?�이?��? ?�역변?��? ?�용??조건부 계산
    if (some.somedata > 5000) {
        b = some.somedata / 100 + c;
        printf("Result: b = %d (some.somedata > 5000 condition)\n", b);
    } else if (some.somedata > 1000) {
        b = some.somedata % 100 + a;
        printf("Result: b = %d (1000 < some.somedata <= 5000 condition)\n", b);
    } else {
        b = some.somedata + a + c;
        printf("Result: b = %d (some.somedata <= 1000 condition)\n", b);
    }
    
    // ?�역변??a ?�데?�트
    a = (a + some.somedata) % 20;
    printf("Updated a = %d\n", a);
}

void func3(COMP comp)
{
    printf("=== func3 ===\n");
    printf("Parameter comp.data = %u\n", comp.data);
    printf("Parameter comp.arr values:\n");
    for (int i = 0; i < 10; i++) {
        printf("  comp.arr[%d] = %u\n", i, comp.arr[i]);
    }
    printf("Parameter comp.someSt.somedata = %u\n", comp.someSt.somedata);
    printf("Parameter comp.ptrNode = %p\n", (void*)comp.ptrNode);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // 복잡???�차???�계 분석 �??�턴 매칭 ?�고리즘
    unsigned int prime_factors[10] = {2, 3, 5, 7, 11, 13, 17, 19, 23, 29};
    unsigned int fibonacci[10] = {1, 1, 2, 3, 5, 8, 13, 21, 34, 55};
    unsigned int factorial_cache[10] = {1, 1, 2, 6, 24, 120, 720, 5040, 40320, 362880};
    
    // 1?�계: 배열 ?�소?�의 ?�중 ?�계 계산
    unsigned int sum = 0, product = 1, xor_result = 0;
    unsigned int min_val = comp.arr[0], max_val = comp.arr[0];
    unsigned int even_count = 0, odd_count = 0, prime_count = 0;
    unsigned int perfect_square_count = 0, power_of_2_count = 0;
    
    for (int i = 0; i < 10; i++) {
        unsigned int val = comp.arr[i];
        sum += val;
        if (product != 0 && val != 0) product = (product * val) % 1000000007; // 0 곱셈 방�?
        xor_result ^= val;
        
        if (val < min_val) min_val = val;
        if (val > max_val) max_val = val;
        
        if (val % 2 == 0) even_count++;
        else odd_count++;
        
        // ?�수 ?�별 (?�전, 0/1/?�수/과�?�?방�?)
        int is_prime = 1;
        if (val <= 1 || val > 1000000) is_prime = 0;
        else {
            int loop_limit = 0;
            for (int j = 2; j * j <= val && j < 100 && j < val; j++) {
                if (val % j == 0) {
                    is_prime = 0;
                    break;
                }
                if (++loop_limit > 100) { is_prime = 0; break; }
            }
        }
        if (is_prime) prime_count++;
        
        // ?�전?�곱???�별 (?�전, 0/?�수/과�?�?방�?)
        unsigned int sqrt_val = 0;
        if (val > 0 && val < 1000000) {
            for (unsigned int j = 1; j * j <= val && j < 1000; j++) {
                if (j * j == val) {
                    sqrt_val = j;
                    break;
                }
            }
        }
        if (sqrt_val > 0) perfect_square_count++;
        
        // 2??거듭?�곱 ?�별
        if (val > 0 && (val & (val - 1)) == 0) power_of_2_count++;
    }
    
    // 2?�계: 복잡???�학??변??�??�턴 분석
    unsigned int harmonic_mean = 0;
    if (sum > 0) {
        double harmonic_sum = 0.0;
        for (int i = 0; i < 10; i++) {
            if (comp.arr[i] > 0) {
                harmonic_sum += 1.0 / comp.arr[i];
            }
        }
        if (harmonic_sum > 0) {
            harmonic_mean = (unsigned int)(10.0 / harmonic_sum);
        }
    }
    
    // 3?�계: ?�보?�치 ?�열과의 ?��?관�?분석
    unsigned int fib_correlation = 0;
    for (int i = 0; i < 10; i++) {
        for (int j = 0; j < 10; j++) {
            if (comp.arr[i] == fibonacci[j]) {
                fib_correlation += (i + 1) * (j + 1);
            }
        }
    }
    
    // 4?�계: ?�인?�분??기반 복잡??계산
    unsigned int prime_factor_sum = 0;
    for (int i = 0; i < 10; i++) {
        unsigned int val = comp.arr[i];
        int pf_limit = 0;
        for (int j = 0; j < 10; j++) {
            while (val > 1 && val % prime_factors[j] == 0) {
                prime_factor_sum += prime_factors[j];
                val /= prime_factors[j];
                if (++pf_limit > 100) break;
            }
            if (pf_limit > 100) break;
        }
    }
    
    // 5?�계: ?�중 조건부 분기 �?복합 ?�산
    unsigned int result = 0;
    unsigned int complexity_score = 0;
    
    // 복잡???�수 계산
    complexity_score += even_count * 2;
    complexity_score += odd_count * 3;
    complexity_score += prime_count * 5;
    complexity_score += perfect_square_count * 7;
    complexity_score += power_of_2_count * 11;
    complexity_score += (max_val - min_val) % 13;
    complexity_score += harmonic_mean % 17;
    complexity_score += fib_correlation % 19;
    complexity_score += prime_factor_sum % 23;
    complexity_score += xor_result % 29;
    
    // ?�중 조건부 분기
    if (complexity_score > 1000) {
        if (prime_count > 3) {
            result = (product + harmonic_mean + fib_correlation) % 1000;
            printf("Result: %u (complexity > 1000 && prime_count > 3)\n", result);
        } else if (perfect_square_count > 1) {
            result = (sum + prime_factor_sum + xor_result) % 1000;
            printf("Result: %u (complexity > 1000 && perfect_squares > 1)\n", result);
        } else {
            result = (max_val + min_val + harmonic_mean) % 1000;
            printf("Result: %u (complexity > 1000 && other conditions)\n", result);
        }
    } else if (complexity_score > 500) {
        if (even_count > odd_count) {
            result = (even_count * 100 + odd_count * 10 + prime_count) % 1000;
            printf("Result: %u (500 < complexity <= 1000 && even > odd)\n", result);
        } else {
            result = (odd_count * 100 + even_count * 10 + power_of_2_count) % 1000;
            printf("Result: %u (500 < complexity <= 1000 && odd >= even)\n", result);
        }
    } else {
        if (fib_correlation > 50) {
            result = (fib_correlation + harmonic_mean + prime_factor_sum) % 1000;
            printf("Result: %u (complexity <= 500 && fib_correlation > 50)\n", result);
        } else {
            result = (sum + product + xor_result) % 1000;
            printf("Result: %u (complexity <= 500 && fib_correlation <= 50)\n", result);
        }
    }
    
    // 6?�계: ?�역변??복합 ?�데?�트
    unsigned int final_result = result;
    
    // comp.data?�???�호?�용
    if (comp.data > 0) {
        final_result = (final_result * comp.data) % 10000;
        if (comp.data % 2 == 0) {
            final_result = (final_result + complexity_score) % 10000;
        } else {
            final_result = (final_result - complexity_score + 10000) % 10000;
        }
    }
    
    // someSt ?�이?��????�호?�용
    if (comp.someSt.somedata > 0) {
        final_result = (final_result ^ comp.someSt.somedata) % 10000;
        if (comp.someSt.somedata % 3 == 0) {
            final_result = (final_result + prime_count * 100) % 10000;
        }
    }
    
    // ?�인??주소�??�용
    if (comp.ptrNode != NULL) {
        unsigned long long addr = (unsigned long long)comp.ptrNode;
        final_result = (final_result + (unsigned int)(addr % 10000)) % 10000;
    }
    
    // ?�역변?�들과의 복합 ?�산
    c = (final_result + a * 100 + b * 10) % 10000;
    b = (b + complexity_score + prime_count * 50) % 200;
    a = (a + harmonic_mean + perfect_square_count * 20) % 100;
    
    printf("Complexity Score: %u\n", complexity_score);
    printf("Statistics - Sum: %u, Product: %u, XOR: %u\n", sum, product, xor_result);
    printf("Counts - Even: %u, Odd: %u, Prime: %u, Perfect Square: %u, Power of 2: %u\n", 
           even_count, odd_count, prime_count, perfect_square_count, power_of_2_count);
    printf("Advanced - Harmonic Mean: %u, Fib Correlation: %u, Prime Factor Sum: %u\n", 
           harmonic_mean, fib_correlation, prime_factor_sum);
    printf("Final Result: %u, Updated a=%d, b=%d, c=%d\n", final_result, a, b, c);
}

void func4(STATE state)
{
    printf("=== func4 ===\n");
    printf("Parameter state = %d\n", state);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: STATE enum 값에 ?�른 조건부 처리
    switch (state) {
        case READY:
            a = a + 5;
            printf("Result: a = %d (READY state)\n", a);
            break;
        case WORKING:
            b = b * 2;
            printf("Result: b = %d (WORKING state)\n", b);
            break;
        case PAUSED:
            c = c - 3;
            printf("Result: c = %d (PAUSED state)\n", c);
            break;
        case SUSPEND:
            a = a + b + c;
            printf("Result: a = %d (SUSPEND state)\n", a);
            break;
        default:
            a = a + b + c;
            printf("Result: a = %d (Unknown state: %d)\n", a, state);
            break;
    }
    
    // ?�역변???�데?�트
    if (state > 50) {
        b = (b + state) % 25;
        printf("Updated b = %d (state > 50)\n", b);
    }
    printf("func4 completed successfully\n");
}

// 배열 ?�???�스?��? ?�한 ?�로???�수??
void func5(int arr[5], char str[20]);
void func6(int matrix[3][4]);
void func7(int* ptr_arr[10]);

void func5(int arr[5], char str[20])
{
    printf("=== func5 ===\n");
    printf("Parameter arr values:\n");
    for (int i = 0; i < 5; i++) {
        printf("  arr[%d] = %d\n", i, arr[i]);
    }
    printf("Parameter str values:\n");
    for (int i = 0; i < 5; i++) {
        printf("  str[%d] = '%c'\n", i, str[i]);
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: 배열 ?�소?�의 최�?값과 최소�?찾기
    int max_val = arr[0], min_val = arr[0];
    for (int i = 1; i < 5; i++) {
        if (arr[i] > max_val) max_val = arr[i];
        if (arr[i] < min_val) min_val = arr[i];
    }
    
    printf("Array max = %d, min = %d\n", max_val, min_val);
    
    // 조건부 로직: 최�?값과 ?�역변??비교
    if (max_val > a * 100) {
        c = max_val / 100 + b;
        printf("Result: c = %d (max_val > a*100 condition)\n", c);
    } else {
        c = max_val + min_val + a;
        printf("Result: c = %d (max_val <= a*100 condition)\n", c);
    }
    
    // 문자??처리: �?번째 ?�효??문자 찾기
    int first_char = 0;
    for (int i = 0; i < 20; i++) {
        if (str[i] != '\0' && str[i] != ' ') {
            first_char = str[i];
            break;
        }
    }
    
    // ?�역변???�데?�트
    b = (b + first_char) % 40;
    printf("Updated b = %d (based on first char: %d)\n", b, first_char);
}

void func6(int matrix[3][4])
{
    printf("=== func6 ===\n");
    printf("Parameter matrix values:\n");
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 4; j++) {
            printf("  matrix[%d][%d] = %d\n", i, j, matrix[i][j]);
        }
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: ?�별 ?�계?�??�각???�소?�의 ??계산
    int row_sums[3] = {0, 0, 0};
    int diagonal_sum = 0;
    
    for (int i = 0; i < 3; i++) {
        for (int j = 0; j < 4; j++) {
            row_sums[i] += matrix[i][j];
            if (i == j) { // ?�각???�소 (3x4 ?�렬?�서??�?3개만)
                diagonal_sum += matrix[i][j];
            }
        }
    }
    
    printf("Row sums: [%d, %d, %d], Diagonal sum: %d\n", 
           row_sums[0], row_sums[1], row_sums[2], diagonal_sum);
    
    // 조건부 로직: 가?????�의 ?�과 ?�역변??비교
    int max_row_sum = row_sums[0];
    for (int i = 1; i < 3; i++) {
        if (row_sums[i] > max_row_sum) max_row_sum = row_sums[i];
    }
    
    if (max_row_sum > diagonal_sum * 2) {
        a = max_row_sum / 100 + b;
        printf("Result: a = %d (max_row_sum > diagonal_sum*2 condition)\n", a);
    } else {
        a = diagonal_sum + c;
        printf("Result: a = %d (max_row_sum <= diagonal_sum*2 condition)\n", a);
    }
    
    // ?�역변???�데?�트
    c = (c + diagonal_sum) % 60;
    printf("Updated c = %d\n", c);
}

void func7(int* ptr_arr[10])
{
    printf("=== func7 ===\n");
    printf("Parameter ptr_arr values:\n");
    for (int i = 0; i < 10; i++) {
        printf("  ptr_arr[%d] = %p\n", i, (void*)ptr_arr[i]);
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: ?�인??주소값들???�턴 분석
    int valid_ptrs = 0;
    unsigned long long addr_sum = 0;
    
    for (int i = 0; i < 10; i++) {
        if (ptr_arr[i] != NULL) {
            valid_ptrs++;
            addr_sum += (unsigned long long)ptr_arr[i];
        }
    }
    
    printf("Valid pointers: %d, Address sum: %llu\n", valid_ptrs, addr_sum);
    
    // 조건부 로직: ?�효???�인??개수???�른 처리
    if (valid_ptrs > 5) {
        b = (valid_ptrs * 10) + a;
        printf("Result: b = %d (valid_ptrs > 5 condition)\n", b);
    } else if (valid_ptrs > 0) {
        b = valid_ptrs + c;
        printf("Result: b = %d (0 < valid_ptrs <= 5 condition)\n", b);
    } else {
        b = a + c;
        printf("Result: b = %d (no valid pointers condition)\n", b);
    }
    
    // ?�역변???�데?�트: 주소값의 ?�위 16비트 ?�용
    unsigned int addr_low = (unsigned int)(addr_sum & 0xFFFF);
    c = (c + addr_low) % 100;
    printf("Updated c = %d (based on address low bits: %u)\n", c, addr_low);
}

// 3차원 배열 ?�스??
void func8(int cube[2][3][4]);
void func9(int matrix4d[2][2][3][4]);

void func8(int cube[2][3][4])
{
    printf("=== func8 ===\n");
    printf("Parameter cube values:\n");
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 3; j++) {
            for (int k = 0; k < 4; k++) {
                printf("  cube[%d][%d][%d] = %d\n", i, j, k, cube[i][j][k]);
            }
        }
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: 3차원 배열??�?면별 ?�계 계산
    int face_sums[6] = {0}; // 6�?�?(2x3, 2x4, 3x4 각각 2개씩)
    
    // �?1, 2: i=0, i=1 (2x3)
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 3; j++) {
            for (int k = 0; k < 4; k++) {
                face_sums[i] += cube[i][j][k];
            }
        }
    }
    
    // �?3, 4: j=0, j=2 (2x4)
    for (int i = 0; i < 2; i++) {
        for (int k = 0; k < 4; k++) {
            face_sums[2] += cube[i][0][k];  // j=0
            face_sums[3] += cube[i][2][k];  // j=2
        }
    }
    
    // �?5, 6: k=0, k=3 (2x3)
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 3; j++) {
            face_sums[4] += cube[i][j][0];  // k=0
            face_sums[5] += cube[i][j][3];  // k=3
        }
    }
    
    printf("Face sums: [%d, %d, %d, %d, %d, %d]\n", 
           face_sums[0], face_sums[1], face_sums[2], face_sums[3], face_sums[4], face_sums[5]);
    
    // 조건부 로직: 가????면과 가???��? 면의 차이 계산
    int max_face = face_sums[0], min_face = face_sums[0];
    for (int i = 1; i < 6; i++) {
        if (face_sums[i] > max_face) max_face = face_sums[i];
        if (face_sums[i] < min_face) min_face = face_sums[i];
    }
    
    int face_diff = max_face - min_face;
    
    if (face_diff > 1000) {
        a = face_diff / 100 + b;
        printf("Result: a = %d (face_diff > 1000 condition)\n", a);
    } else {
        a = face_diff + c;
        printf("Result: a = %d (face_diff <= 1000 condition)\n", a);
    }
    
    // ?�역변???�데?�트
    b = (b + max_face) % 80;
    printf("Updated b = %d (based on max face: %d)\n", b, max_face);
}

void func9(int matrix4d[2][2][3][4])
{
    printf("=== func9 ===\n");
    printf("Parameter matrix4d values:\n");
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            for (int k = 0; k < 3; k++) {
                for (int l = 0; l < 4; l++) {
                    printf("  matrix4d[%d][%d][%d][%d] = %d\n", i, j, k, l, matrix4d[i][j][k][l]);
                }
            }
        }
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: 4차원 배열??�?차원�??�계 계산
    int layer_sums[4] = {0}; // 4�??�이??(i=0, i=1, j=0, j=1)
    int total_sum = 0;
    int positive_count = 0;
    
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            for (int k = 0; k < 3; k++) {
                for (int l = 0; l < 4; l++) {
                    int val = matrix4d[i][j][k][l];
                    total_sum += val;
                    if (val > 0) positive_count++;
                    
                    // ?�이?�별 ?�계
                    if (i == 0) layer_sums[0] += val;
                    if (i == 1) layer_sums[1] += val;
                    if (j == 0) layer_sums[2] += val;
                    if (j == 1) layer_sums[3] += val;
                }
            }
        }
    }
    
    printf("Layer sums: [%d, %d, %d, %d], Total: %d, Positive count: %d\n", 
           layer_sums[0], layer_sums[1], layer_sums[2], layer_sums[3], total_sum, positive_count);
    
    // 조건부 로직: ?�수 개수?�??�이???�계 비교
    if (positive_count > 20) {
        c = positive_count + layer_sums[0] % 100;
        printf("Result: c = %d (positive_count > 20 condition)\n", c);
    } else if (total_sum > 0) {
        c = total_sum / 100 + a;
        printf("Result: c = %d (0 < positive_count <= 20 condition)\n", c);
    } else {
        c = b + layer_sums[1] % 50;
        printf("Result: c = %d (no positive values condition)\n", c);
    }
    
    // ?�역변???�데?�트: 가?????�이???�계 ?�용
    int max_layer = layer_sums[0];
    for (int i = 1; i < 4; i++) {
        if (layer_sums[i] > max_layer) max_layer = layer_sums[i];
    }
    
    a = (a + max_layer) % 120;
    printf("Updated a = %d (based on max layer: %d)\n", a, max_layer);
}

// 5차원 배열 ?�스??(최�? 지??차원)
void func10(int matrix5d[2][2][2][3][4]);

// 6차원 배열 ?�스??(?�한 초과 - 경고 메시지 ?�인??
void func11(int matrix6d[2][2][2][2][3][4]);

void func10(int matrix5d[2][2][2][3][4])
{
    printf("=== func10 ===\n");
    printf("Parameter matrix5d values (showing first few elements):\n");
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            for (int k = 0; k < 2; k++) {
                for (int l = 0; l < 3; l++) {
                    for (int m = 0; m < 4; m++) {
                        printf("  matrix5d[%d][%d][%d][%d][%d] = %d\n", i, j, k, l, m, matrix5d[i][j][k][l][m]);
                    }
                }
            }
        }
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: 5차원 배열??복잡???�턴 분석
    int slice_sums[8] = {0}; // 8�??�라?�스 (i,j,k 조합)
    int even_sum = 0, odd_sum = 0;
    int max_val = matrix5d[0][0][0][0][0], min_val = matrix5d[0][0][0][0][0];
    
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            for (int k = 0; k < 2; k++) {
                int slice_idx = i * 4 + j * 2 + k;
                for (int l = 0; l < 3; l++) {
                    for (int m = 0; m < 4; m++) {
                        int val = matrix5d[i][j][k][l][m];
                        slice_sums[slice_idx] += val;
                        
                        if (val % 2 == 0) even_sum += val;
                        else odd_sum += val;
                        
                        if (val > max_val) max_val = val;
                        if (val < min_val) min_val = val;
                    }
                }
            }
        }
    }
    
    printf("Slice sums: [%d, %d, %d, %d, %d, %d, %d, %d]\n", 
           slice_sums[0], slice_sums[1], slice_sums[2], slice_sums[3], 
           slice_sums[4], slice_sums[5], slice_sums[6], slice_sums[7]);
    printf("Even sum: %d, Odd sum: %d, Range: %d\n", even_sum, odd_sum, max_val - min_val);
    
    // 조건부 로직: ?�???�과 짝수 ??비교
    if (odd_sum > even_sum) {
        b = odd_sum / 100 + a;
        printf("Result: b = %d (odd_sum > even_sum condition)\n", b);
    } else if (even_sum > odd_sum) {
        b = even_sum / 100 + c;
        printf("Result: b = %d (even_sum > odd_sum condition)\n", b);
    } else {
        b = (max_val - min_val) + a;
        printf("Result: b = %d (odd_sum == even_sum condition)\n", b);
    }
    
    // ?�역변???�데?�트: 가?????�라?�스 ?�계 ?�용
    int max_slice = slice_sums[0];
    for (int i = 1; i < 8; i++) {
        if (slice_sums[i] > max_slice) max_slice = slice_sums[i];
    }
    
    c = (c + max_slice) % 150;
    printf("Updated c = %d (based on max slice: %d)\n", c, max_slice);
}

void func11(int matrix6d[2][2][2][2][3][4])
{
    printf("=== func11 ===\n");
    printf("Parameter matrix6d values (showing first few elements):\n");
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            for (int k = 0; k < 2; k++) {
                for (int l = 0; l < 2; l++) {
                    for (int m = 0; m < 3; m++) {
                        for (int n = 0; n < 4; n++) {
                            printf("  matrix6d[%d][%d][%d][%d][%d][%d] = %d\n", i, j, k, l, m, n, matrix6d[i][j][k][l][m][n]);
                        }
                    }
                }
            }
        }
    }
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // ?�스??로직: 6차원 배열??고급 ?�턴 분석
    int hypercube_sums[16] = {0}; // 16�??�이?�큐�?(i,j,k,l 조합)
    int quadrant_sums[4] = {0};   // 4�??�분�?(i,j 조합)
    int positive_quadrants = 0;
    
    for (int i = 0; i < 2; i++) {
        for (int j = 0; j < 2; j++) {
            int quadrant_idx = i * 2 + j;
            for (int k = 0; k < 2; k++) {
                for (int l = 0; l < 2; l++) {
                    int hypercube_idx = i * 8 + j * 4 + k * 2 + l;
                    for (int m = 0; m < 3; m++) {
                        for (int n = 0; n < 4; n++) {
                            int val = matrix6d[i][j][k][l][m][n];
                            hypercube_sums[hypercube_idx] += val;
                            quadrant_sums[quadrant_idx] += val;
                        }
                    }
                }
            }
        }
    }
    
    // ?�수 ?�분�?개수 계산
    for (int i = 0; i < 4; i++) {
        if (quadrant_sums[i] > 0) positive_quadrants++;
    }
    
    printf("Hypercube sums: [%d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d, %d]\n", 
           hypercube_sums[0], hypercube_sums[1], hypercube_sums[2], hypercube_sums[3],
           hypercube_sums[4], hypercube_sums[5], hypercube_sums[6], hypercube_sums[7],
           hypercube_sums[8], hypercube_sums[9], hypercube_sums[10], hypercube_sums[11],
           hypercube_sums[12], hypercube_sums[13], hypercube_sums[14], hypercube_sums[15]);
    printf("Quadrant sums: [%d, %d, %d, %d], Positive quadrants: %d\n", 
           quadrant_sums[0], quadrant_sums[1], quadrant_sums[2], quadrant_sums[3], positive_quadrants);
    
    // 조건부 로직: ?�수 ?�분�?개수?�??�이?�큐�??�계 비교
    if (positive_quadrants >= 3) {
        a = positive_quadrants * 10 + quadrant_sums[0] % 50;
        printf("Result: a = %d (positive_quadrants >= 3 condition)\n", a);
    } else if (positive_quadrants >= 1) {
        a = positive_quadrants * 5 + quadrant_sums[1] % 30;
        printf("Result: a = %d (1 <= positive_quadrants < 3 condition)\n", a);
    } else {
        a = quadrant_sums[2] + quadrant_sums[3];
        printf("Result: a = %d (no positive quadrants condition)\n", a);
    }
    
    // ?�역변???�데?�트: 가?????�이?�큐�??�계 ?�용
    int max_hypercube = hypercube_sums[0];
    for (int i = 1; i < 16; i++) {
        if (hypercube_sums[i] > max_hypercube) max_hypercube = hypercube_sums[i];
    }
    
    b = (b + max_hypercube) % 200;
    printf("Updated b = %d (based on max hypercube: %d)\n", b, max_hypercube);
}

// ?�기 참조 구조�?_NODE�?depth 2�??�용?�는 ?�수
void func12(NODE* node_list, int count)
{
    printf("=== func12 ===\n");
    printf("Parameter node_list count = %d\n", count);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // 1?�계: ?�드 리스?�의 기본 ?�계 분석
    unsigned int total_data = 0;
    unsigned int max_data = 0, min_data = 0xFFFFFFFF;
    int valid_nodes = 0;
    
    for (int i = 0; i < count; i++) {
        if (node_list[i].data > 0) {
            total_data += node_list[i].data;
            if (node_list[i].data > max_data) max_data = node_list[i].data;
            if (node_list[i].data < min_data) min_data = node_list[i].data;
            valid_nodes++;
        }
    }
    
    printf("Node statistics: total_data=%u, max_data=%u, min_data=%u, valid_nodes=%d\n", 
           total_data, max_data, min_data, valid_nodes);
    
    // 2?�계: ?�기 참조 구조체의 ?�결 관�?분석 (depth 2)
    int circular_refs = 0;
    int self_refs = 0;
    int broken_chains = 0;
    int valid_chains = 0;
    
    printf("func12: Starting loop with count = %d\n", count);
    for (int i = 0; i < count; i++) {
        printf("func12: Processing node[%d]\n", i);
        NODE* current = &node_list[i];
        printf("func12: current = %p\n", (void*)current);
        
        // ?�기 참조 검??
        printf("func12: Checking self-reference for node[%d]\n", i);
        if (current->prev == current || current->next == current) {
            self_refs++;
            printf("  Node[%d]: Self-reference detected\n", i);
        }
        
        // ?�환 참조 검??(depth 2)
        printf("func12: Checking next pointer for node[%d]\n", i);
        if (current->next != NULL) {
            NODE* next = current->next;
            printf("func12: next = %p\n", (void*)next);
            // ?�전??방어?�인 코드: next가 ?�효???�인?�인지 ?�인
            if (next && (void*)next != (void*)0x104 && next->prev == current) {
                valid_chains++;
                printf("  Node[%d]->Node[%d]: Valid bidirectional link\n", i, i+1);
                
                // depth 2: ?�음 ?�드???�음 ?�드 검??(배열 범위 체크)
                printf("func12: Checking next->next for node[%d]\n", i);
                if (next->next != NULL && next->next->prev == next) {
                    circular_refs++;
                    printf("  Node[%d]->Node[%d]->Node[%d]: Circular chain detected\n", i, i+1, i+2);
                }
            } else {
                broken_chains++;
                printf("  Node[%d]->Node[%d]: Broken chain (prev mismatch or invalid pointer)\n", i, i+1);
            }
        } else {
            broken_chains++;
            printf("  Node[%d]: End of chain (next is NULL)\n", i);
        }
        
        // ?�버�? �??�드???�태 출력
        printf("  Node[%d] processed successfully\n", i);
    }
    printf("func12: Loop completed\n");
    
    printf("Chain analysis: circular_refs=%d, self_refs=%d, broken_chains=%d, valid_chains=%d\n", 
           circular_refs, self_refs, broken_chains, valid_chains);
    
    // 조건부 로직: ?�결 관계�? ?�이???�계�??�용??계산
    if (circular_refs > 0 && valid_nodes > 1) {
        c = (total_data / valid_nodes) + circular_refs * 10;
        printf("Result: c = %d (circular_refs > 0 && valid_nodes > 1 condition)\n", c);
    } else if (valid_chains > broken_chains) {
        c = max_data - min_data + valid_chains;
        printf("Result: c = %d (valid_chains > broken_chains condition)\n", c);
    } else {
        c = total_data % 100 + self_refs * 5;
        printf("Result: c = %d (default condition)\n", c);
    }
    
    // ?�역변???�데?�트: ?�효???�드 ?��? 최�? ?�이???�용
    a = (a + valid_nodes * 10) % 100;
    b = (b + max_data % 50) % 100;
    printf("Updated a = %d (based on valid_nodes: %d)\n", a, valid_nodes);
    printf("Updated b = %d (based on max_data: %u)\n", b, max_data);
    printf("func12 completed successfully\n");
    printf("func12: About to return\n");
}

// 복잡??구조�?_COMP�?depth 2�??�용?�는 ?�수
void func13(COMP* comp_array, int size)
{
    printf("=== func13 ===\n");
    printf("Parameter comp_array size = %d\n", size);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // 1?�계: COMP 구조�?배열??기본 분석
    unsigned int total_comp_data = 0;
    unsigned int total_some_data = 0;
    int valid_comps = 0;
    int valid_nodes = 0;
    
    for (int i = 0; i < size; i++) {
        if (comp_array[i].data > 0) {
            total_comp_data += comp_array[i].data;
            total_some_data += comp_array[i].someSt.somedata;
            valid_comps++;
            
            if (comp_array[i].ptrNode != NULL) {
                valid_nodes++;
            }
        }
    }
    
    printf("COMP statistics: total_comp_data=%u, total_some_data=%u, valid_comps=%d, valid_nodes=%d\n", 
           total_comp_data, total_some_data, valid_comps, valid_nodes);
    
    // 2?�계: COMP 구조�??��? 배열�??�인?�의 depth 2 분석
    unsigned int array_sums[10] = {0};  // �??�덱?�별 ?�계
    unsigned int array_maxs[10] = {0};  // �??�덱?�별 최�?�?
    int array_patterns = 0;
    int node_connections = 0;
    
    for (int i = 0; i < size; i++) {
        COMP* comp = &comp_array[i];
        
        // 배열 ?�소?�의 ?�턴 분석 (depth 2)
        for (int j = 0; j < 10; j++) {
            array_sums[j] += comp->arr[j];
            if (comp->arr[j] > array_maxs[j]) {
                array_maxs[j] = comp->arr[j];
            }
        }
        
        // 배열 ?�턴 검?? ?�속??증�?/감소 ?�턴
        int increasing = 0, decreasing = 0;
        for (int j = 1; j < 10; j++) {
            if (comp->arr[j] > comp->arr[j-1]) increasing++;
            else if (comp->arr[j] < comp->arr[j-1]) decreasing++;
        }
        
        if (increasing > 5 || decreasing > 5) {
            array_patterns++;
            printf("  COMP[%d]: Array pattern detected (inc=%d, dec=%d)\n", i, increasing, decreasing);
        }
        
        // ?�인???�드 ?�결 분석 (depth 2)
        if (comp->ptrNode != NULL) {
            NODE* node = comp->ptrNode;
            if (node->data > 0) {
                node_connections++;
                printf("  COMP[%d]->NODE: Valid connection (data=%u)\n", i, node->data);
                
                // depth 2: ?�드???�결 관�?검??
                if (node->next != NULL && node->next->data > 0) {
                    printf("  COMP[%d]->NODE->NODE: Extended chain detected\n", i);
                }
            }
        }
    }
    
    printf("Depth 2 analysis: array_patterns=%d, node_connections=%d\n", array_patterns, node_connections);
    printf("Array index sums: [%u, %u, %u, %u, %u, %u, %u, %u, %u, %u]\n", 
           array_sums[0], array_sums[1], array_sums[2], array_sums[3], array_sums[4],
           array_sums[5], array_sums[6], array_sums[7], array_sums[8], array_sums[9]);
    
    // 조건부 로직: 복잡??구조�?분석 결과�??�용??계산
    if (array_patterns > 0 && valid_comps > 0) {
        c = (total_comp_data / valid_comps) + array_patterns * 5;
        printf("Result: c = %d (array_patterns > 0 && valid_comps > 0 condition)\n", c);
    } else if (node_connections > 0) {
        c = total_some_data + node_connections * 10;
        printf("Result: c = %d (node_connections > 0 condition)\n", c);
    } else {
        c = array_sums[0] + array_sums[9];  // �?번째?�?마�?�??�덱????
        printf("Result: c = %d (default condition)\n", c);
    }
    
    // ?�역변???�데?�트: 배열 ?�턴�??�드 ?�결 ???�용
    a = (a + array_patterns * 3) % 50;
    b = (b + node_connections * 7) % 50;
    printf("Updated a = %d (based on array_patterns: %d)\n", a, array_patterns);
    printf("Updated b = %d (based on node_connections: %d)\n", b, node_connections);
}

// ?�합 구조�?_NODE?�?_COMP�?depth 2�??�용?�는 ?�수
void func14(NODE* root, COMP* context)
{
    printf("=== func14 ===\n");
    printf("Parameter root node data = %u\n", root->data);
    printf("Parameter context data = %u\n", context->data);
    printf("Global variable a = %d\n", a);
    printf("Global variable b = %d\n", b);
    printf("Global variable c = %d\n", c);
    
    // 1?�계: 루트 ?�드???�결 관�?분석
    int root_connections = 0;
    unsigned int connection_sum = 0;
    
    if (root->prev != NULL && root->prev->data > 0) {
        root_connections++;
        connection_sum += root->prev->data;
        printf("  Root->Prev: Valid connection (data=%u)\n", root->prev->data);
    }
    
    if (root->next != NULL && root->next->data > 0) {
        root_connections++;
        connection_sum += root->next->data;
        printf("  Root->Next: Valid connection (data=%u)\n", root->next->data);
    }
    
    // 2?�계: 컨텍?�트 구조체의 depth 2 분석
    unsigned int context_array_sum = 0;
    unsigned int context_array_max = 0;
    int context_array_pattern = 0;
    
    for (int i = 0; i < 10; i++) {
        context_array_sum += context->arr[i];
        if (context->arr[i] > context_array_max) {
            context_array_max = context->arr[i];
        }
    }
    
    // 배열 ?�턴 검?? ?�??짝수 ?�턴
    int odd_count = 0, even_count = 0;
    for (int i = 0; i < 10; i++) {
        if (context->arr[i] % 2 == 0) even_count++;
        else odd_count++;
    }
    
    if (odd_count > even_count) {
        context_array_pattern = 1;  // ?�???�세
    } else if (even_count > odd_count) {
        context_array_pattern = 2;  // 짝수 ?�세
    }
    
    printf("Context analysis: array_sum=%u, array_max=%u, pattern=%d (0=none, 1=odd, 2=even)\n", 
           context_array_sum, context_array_max, context_array_pattern);
    
    // 3?�계: 루트 ?�드?�?컨텍?�트???�호?�용 분석 (depth 2)
    int interaction_score = 0;
    
    // 루트 ?�이?��? 컨텍?�트 ?�이?�의 관�?
    if (root->data > context->data) {
        interaction_score += 10;
        printf("  Root data (%u) > Context data (%u)\n", root->data, context->data);
    }
    
    // 루트 ?�결�?컨텍?�트 배열 ?�턴??관�?
    if (root_connections > 0 && context_array_pattern > 0) {
        interaction_score += 5;
        printf("  Root connections (%d) + Context pattern (%d) = Enhanced interaction\n", 
               root_connections, context_array_pattern);
    }
    
    // 컨텍?�트???�인???�드?�?루트???�결 관�?(depth 2)
    if (context->ptrNode != NULL && context->ptrNode->data > 0) {
        if (context->ptrNode->data == root->data) {
            interaction_score += 15;
            printf("  Context->Node data (%u) == Root data (%u): Direct match\n", 
                   context->ptrNode->data, root->data);
        }
        
        // depth 2: 컨텍?�트 ?�드???�결 관�?검??
        if (context->ptrNode->next != NULL && context->ptrNode->next->data > 0) {
            interaction_score += 8;
            printf("  Context->Node->Node: Extended chain detected\n");
        }
    }
    
    printf("Interaction analysis: score=%d, connections=%d, pattern=%d\n", 
           interaction_score, root_connections, context_array_pattern);
    
    // 조건부 로직: ?�호?�용 ?�수?�?구조�??�성???�용??계산
    if (interaction_score >= 20) {
        c = (root->data + context->data) / 2 + interaction_score;
        printf("Result: c = %d (high interaction score >= 20 condition)\n", c);
    } else if (interaction_score >= 10) {
        c = connection_sum + context_array_sum % 100;
        printf("Result: c = %d (medium interaction score >= 10 condition)\n", c);
    } else {
        c = root->data % 50 + context_array_max % 50;
        printf("Result: c = %d (low interaction score < 10 condition)\n", c);
    }
    
    // ?�역변???�데?�트: ?�호?�용 ?�수?�??�턴 ?�보 ?�용
    a = (a + interaction_score) % 30;
    b = (b + context_array_pattern * 5) % 30;
    printf("Updated a = %d (based on interaction_score: %d)\n", a, interaction_score);
    printf("Updated b = %d (based on context_array_pattern: %d)\n", b, context_array_pattern);
}
/*int test() = main;*/  // illegal

//struct s {} t;
//struct x {};


// Test 1: Triple pointer array
void test_triple_pointer_array(int*** a[4]) {
    // Function body will be generated by the program
}

// Test 2: Array pointer pointer
void test_array_pointer_pointer(int (*b)[3][2]) {
    // Function body will be generated by the program
}

// Test 3: Struct with triple pointer array
typedef struct {
    int* data;
    float** matrix;
} COMP_ST;

void test_struct_triple_pointer_array(COMP_ST*** comp[4]) {
    // Function body will be generated by the program
}

// Test 4: Struct with internal pointer
struct A {
    int* p;
};

void test_struct_internal_pointer(struct A obj) {
    // Function body will be generated by the program
}

// Test 5: Struct with array pointer
struct B {
    float (*m)[2];
};

void test_struct_array_pointer(struct B obj2) {
    // Function body will be generated by the program
}

// Test 6: Struct with struct pointer
struct C {
    struct A* a;
};

void test_struct_struct_pointer(struct C obj3) {
    // Function body will be generated by the program
}

// Test 7: Pointer array of pointers
void test_pointer_array_of_pointers(int** ptrs[3]) {
    // Function body will be generated by the program
}

// Test 8: Multi-dimensional struct pointer
typedef struct {
    int x;
    float y;
} MyStruct;

void test_multi_dimensional_struct_pointer(MyStruct**** arr[2][2]) {
    // Function body will be generated by the program
}

// Test 9: Complex struct
struct Complex {
    float** a;
    int* b[3];
};

void test_complex_struct(struct Complex obj4) {
    // Function body will be generated by the program
}

// Test 10: Multi-dimensional array pointer
void test_multi_dimensional_array_pointer(int (*x)[2][3][4]) {
    // Function body will be generated by the program
}

// Additional complex test cases

// Test 11: Function pointer
typedef int (*func_ptr)(int, float);

void test_function_pointer(func_ptr fp) {
    // Function body will be generated by the program
}

// Test 12: Nested struct with pointers
struct Outer {
    int* outer_ptr;
    struct {
        float* inner_ptr;
        double** double_ptr;
    } inner;
};

void test_nested_struct_pointers(struct Outer outer) {
    // Function body will be generated by the program
}

// Test 13: Array of function pointers
typedef void (*action_func)(int);

void test_array_of_function_pointers(action_func actions[5]) {
    // Function body will be generated by the program
}

// Test 14: Self-referential struct
struct Node {
    int data;
    struct Node* next;
    struct Node** children;
};

void test_self_referential_struct(struct Node* head) {
    // Function body will be generated by the program
}

// Test 15: Union with pointers
union DataUnion {
    int* int_ptr;
    float* float_ptr;
    char** string_ptr;
};

void test_union_with_pointers(union DataUnion data) {
    // Function body will be generated by the program
}


